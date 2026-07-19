export type ExpiryValue = '12h' | `${number}d` | 'never'

export interface ExpiryOption {
  value: ExpiryValue
  label: string
  danger?: boolean
}

const DEFAULT_MAX_EXPIRY_DAYS = 14
const MIN_MAX_EXPIRY_DAYS = 1
const HARD_MAX_EXPIRY_DAYS = 365
const DAY_OPTION_CANDIDATES = [1, 3, 7, 14, 30, 60, 90, 180, 365] as const

function parseMaxExpiryDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_EXPIRY_DAYS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_EXPIRY_DAYS
  return Math.min(HARD_MAX_EXPIRY_DAYS, Math.max(MIN_MAX_EXPIRY_DAYS, parsed))
}

function formatDayLabel(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`
}

export const maxExpiryDays = parseMaxExpiryDays(import.meta.env.VITE_MAX_EXPIRY_DAYS)

const dayChoices = Array.from(
  new Set([
    ...DAY_OPTION_CANDIDATES.filter((days) => days <= maxExpiryDays),
    maxExpiryDays,
  ]),
).sort((a, b) => a - b)

const dayChoiceValues = new Set(dayChoices.map((days) => `${days}d`))
export const defaultExpiryValue: ExpiryValue = dayChoiceValues.has('14d') ? '14d' : `${maxExpiryDays}d`

export const expiryOptions: ExpiryOption[] = [
  { value: '12h', label: '12 hours' },
  ...dayChoices.map((days) => ({ value: `${days}d` as ExpiryValue, label: formatDayLabel(days) })),
  { value: 'never', label: 'Forever', danger: true },
]

export function isValidExpiryValue(value: string | null | undefined): value is ExpiryValue {
  if (!value) return false
  if (value === '12h' || value === 'never') return true
  return dayChoiceValues.has(value)
}
