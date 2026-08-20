import { ref } from 'vue'

export interface AvatarPrefs {
  /** Background color used while no picture is set (and behind it). */
  color: string
  /** Resized picture as a data URL, or null to show the username initials. */
  image: string | null
}

const AVATAR_KEY = 'yp_avatar'
const AVATAR_TILE_SIZE = 128
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_STORED_CHARS = 350_000

export const AVATAR_COLORS = [
  '#b45309',
  '#d97706',
  '#b91c1c',
  '#15803d',
  '#1d4ed8',
  '#7c3aed',
  '#0f766e',
  '#57534e',
] as const

export const DEFAULT_AVATAR: AvatarPrefs = { color: AVATAR_COLORS[0], image: null }

function readStoredAvatar(): AvatarPrefs | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(AVATAR_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AvatarPrefs>
    if (typeof parsed.color !== 'string') return null
    if (parsed.image !== undefined && parsed.image !== null && typeof parsed.image !== 'string') return null
    return { color: parsed.color, image: parsed.image ?? null }
  } catch {
    return null
  }
}

const avatarPrefs = ref<AvatarPrefs>(readStoredAvatar() ?? DEFAULT_AVATAR)

export function useAvatar() {
  function save(next: AvatarPrefs) {
    avatarPrefs.value = { ...next }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(AVATAR_KEY, JSON.stringify(avatarPrefs.value))
    }
  }
  return { avatarPrefs, save }
}

/** Text painted inside the avatar tile when no picture is set. */
export function avatarGlyph(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Could not read the image'))
    reader.readAsDataURL(file)
  })
}

/**
 * Loads a picture file, crops it to a square, downscales it to the avatar
 * tile size, and returns a compact PNG data URL that fits in localStorage.
 */
export async function readAvatarImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Image is too large (max 5 MB)')

  const source = await readFileAsDataUrl(file)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not read the image'))
    img.src = source
  })

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_TILE_SIZE
  canvas.height = AVATAR_TILE_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the image')

  // Center-crop the source into a square before scaling.
  const side = Math.min(image.width, image.height)
  const sx = (image.width - side) / 2
  const sy = (image.height - side) / 2
  context.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_TILE_SIZE, AVATAR_TILE_SIZE)

  const resized = canvas.toDataURL('image/png')
  if (resized.length > MAX_STORED_CHARS) throw new Error('Image is too large after resizing')
  return resized
}
