function base64UrlToBytes(value: unknown, field = 'value'): Uint8Array {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Passkey response is missing ${field}`)
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toArrayBufferBytes(value: unknown, field?: string): Uint8Array<ArrayBuffer> {
  const source = base64UrlToBytes(value, field)
  const normalized = new Uint8Array(new ArrayBuffer(source.byteLength))
  normalized.set(source)
  return normalized
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function arrayBufferToBase64Url(value: ArrayBuffer): string {
  return bytesToBase64Url(new Uint8Array(value))
}

function passkeyOptionsFromPayload(payload: any): any {
  const options = payload?.publicKey
    ?? payload?.public_key
    ?? payload?.options?.publicKey
    ?? payload?.options?.public_key
    ?? payload?.options
    ?? payload?.data?.publicKey
    ?? payload?.data?.public_key
    ?? payload?.data?.options
    ?? payload?.creationOptions
    ?? payload?.creation_options
    ?? payload?.requestOptions
    ?? payload?.request_options
    ?? payload
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Passkey response did not include browser options')
  }
  return options
}

function descriptorId(descriptor: any): unknown {
  return descriptor?.id ?? descriptor?.credential_id ?? descriptor?.credentialId
}

function mapDescriptorJson(descriptors: any[] | undefined, field: string): PublicKeyCredentialDescriptor[] | undefined {
  if (!descriptors) return undefined
  if (!Array.isArray(descriptors)) throw new Error(`Passkey response has invalid ${field}`)
  return descriptors.map((descriptor, index) => ({
    type: descriptor.type ?? 'public-key',
    id: toArrayBufferBytes(descriptorId(descriptor), `${field}[${index}].id`),
    transports: descriptor.transports,
  }))
}

export function toCreationOptions(payload: any): PublicKeyCredentialCreationOptions {
  const options = passkeyOptionsFromPayload(payload)
  const user = options.user
  if (!user || typeof user !== 'object') throw new Error('Passkey response is missing user details')
  const userId = user.id ?? user.user_id ?? user.userId
  return {
    ...options,
    challenge: toArrayBufferBytes(options.challenge, 'challenge'),
    user: {
      ...user,
      id: toArrayBufferBytes(userId, 'user.id'),
    },
    excludeCredentials: mapDescriptorJson(options.excludeCredentials ?? options.exclude_credentials, 'excludeCredentials'),
  }
}

export function toRequestOptions(payload: any): PublicKeyCredentialRequestOptions {
  const options = passkeyOptionsFromPayload(payload)
  return {
    ...options,
    challenge: toArrayBufferBytes(options.challenge, 'challenge'),
    allowCredentials: mapDescriptorJson(options.allowCredentials ?? options.allow_credentials, 'allowCredentials'),
  }
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function convertValue(value: unknown): JsonValue {
  if (value === undefined) return null
  if (value instanceof ArrayBuffer) return arrayBufferToBase64Url(value)
  if (ArrayBuffer.isView(value)) return bytesToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  if (Array.isArray(value)) return value.map((item) => convertValue(item))
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(value)) result[key] = convertValue(child)
    return result
  }
  return value as JsonValue
}

export function credentialToJson(credential: PublicKeyCredential): JsonValue {
  const response = credential.response
  const payload: Record<string, unknown> = {
    id: credential.id,
    rawId: credential.rawId,
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {},
  }
  if (response instanceof AuthenticatorAttestationResponse) {
    payload.response = {
      clientDataJSON: response.clientDataJSON,
      attestationObject: response.attestationObject,
      transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined,
    }
  } else if (response instanceof AuthenticatorAssertionResponse) {
    payload.response = {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      userHandle: response.userHandle,
    }
  }
  return convertValue(payload)
}

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials
}
