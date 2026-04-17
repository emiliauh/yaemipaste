function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toArrayBufferBytes(value: string): Uint8Array<ArrayBuffer> {
  const source = base64UrlToBytes(value)
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

function mapDescriptorJson(
  descriptors: Array<{ type: PublicKeyCredentialType; id: string; transports?: AuthenticatorTransport[] }>,
): PublicKeyCredentialDescriptor[] {
  return descriptors.map((descriptor) => ({
    type: descriptor.type,
    id: toArrayBufferBytes(descriptor.id),
    transports: descriptor.transports,
  }))
}

export function toCreationOptions(options: any): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: toArrayBufferBytes(options.challenge),
    user: {
      ...options.user,
      id: toArrayBufferBytes(options.user.id),
    },
    excludeCredentials: options.excludeCredentials ? mapDescriptorJson(options.excludeCredentials) : undefined,
  }
}

export function toRequestOptions(options: any): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: toArrayBufferBytes(options.challenge),
    allowCredentials: options.allowCredentials ? mapDescriptorJson(options.allowCredentials) : undefined,
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
