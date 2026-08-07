import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

function ipv4Bytes(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const bytes = parts.map(part => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  return bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : undefined
}

function ipBytes(value: string): number[] | undefined {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = ipv4Bytes(normalized)
  if (v4) return v4
  if (isIP(normalized) !== 6 || normalized.includes('%')) return undefined

  const [head, tail = ''] = normalized.split('::')
  if (normalized.split('::').length > 2) return undefined
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const expand = (part: string): number[] | undefined => {
    if (part.includes('.')) {
      const bytes = ipv4Bytes(part)
      return bytes ? [((bytes[0] << 8) | bytes[1]).toString(16), ((bytes[2] << 8) | bytes[3]).toString(16)].map(item => Number.parseInt(item, 16)) : undefined
    }
    return /^[0-9a-f]{1,4}$/.test(part) ? [Number.parseInt(part, 16)] : undefined
  }
  const groups = [...left, ...right].map(expand)
  if (groups.some(group => !group) || groups.flat().length > 8) return undefined
  const words = normalized.includes('::') ? [...groups.slice(0, left.length), ...Array(8 - groups.flat().length).fill([0]), ...groups.slice(left.length)].flat() : groups.flat()
  if (words.length !== 8) return undefined
  return words.flatMap(word => [word >> 8, word & 0xff])
}

function inPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  if (bytes.length !== prefix.length) return false
  for (let offset = 0; offset < bits; offset++) {
    if (((bytes[Math.floor(offset / 8)] >> (7 - (offset % 8))) & 1) !== ((prefix[Math.floor(offset / 8)] >> (7 - (offset % 8))) & 1)) return false
  }
  return true
}

function blockedIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
}

function blockedIpv6(bytes: number[]): boolean {
  const zero = bytes.every(byte => byte === 0)
  const loopback = bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1
  if (zero || loopback || (bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || bytes[0] === 0xff) return true

  // Global IPv6 unicast currently lives in 2000::/3. Exclude IANA special-use ranges inside it.
  if ((bytes[0] & 0xe0) !== 0x20) return true
  return inPrefix(bytes, [0x20, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 23) ||
    inPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32) ||
    inPrefix(bytes, [0x20, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 16) ||
    inPrefix(bytes, [0x3f, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 20)
}

export function blockedAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true
  const bytes = ipBytes(value)
  if (!bytes) return false
  if (bytes.length === 4) return blockedIpv4(bytes)
  if (inPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return blockedIpv4(bytes.slice(12))
  return blockedIpv6(bytes)
}

export function assertPublicHttpUrl(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('public HTTP(S) URL without credentials is required')
  if (blockedAddress(url.hostname)) throw new Error('target is private')
}

export async function requestPinnedHttp(url: URL, options: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<IncomingMessage> {
  assertPublicHttpUrl(url)
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(item => blockedAddress(item.address))) throw new Error('target is private')
  const address = addresses[0]
  const requestOptions = {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname || '/'}${url.search}`,
    method: options.method,
    headers: options.headers,
    servername: url.hostname,
    // Pin the address checked above so DNS cannot change between validation and connect.
    lookup: ((_: string, __: object, callback: (error: NodeJS.ErrnoException | null, resolvedAddress: string, family: number) => void) => callback(null, address.address, address.family)) as any,
  }
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(requestOptions, resolve)
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('request timed out')))
    request.once('error', reject)
    request.end(options.body)
  })
}
