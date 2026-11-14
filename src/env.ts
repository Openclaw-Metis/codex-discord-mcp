// Small, dependency-free parsers for environment configuration.

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function optional(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined
}
