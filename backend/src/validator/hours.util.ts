/** Helpers shared by the directive validator. */

export const MIN_HOUR = 0;
export const MAX_HOUR = 23;

/** Coerces a JSON value to a finite number, or returns null. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface HoursValidation {
  hours: number[];
  /** Non-fatal repairs (duplicates removed, order fixed, hours outside horizon dropped). */
  warnings: string[];
  /** Set when the value cannot be trusted at all and the directive must be dropped. */
  error?: string;
}

/**
 * Validates an "hours" array from the model: every entry must be an integer in
 * 0-23. Duplicates and bad ordering are repaired (and reported); anything
 * non-numeric or out of range is a hard failure, because that means the model
 * misread the note rather than merely formatting it untidily.
 */
export function validateHours(
  value: unknown,
  horizon: readonly number[],
): HoursValidation {
  const warnings: string[] = [];

  if (!Array.isArray(value) || value.length === 0) {
    return { hours: [], warnings, error: '"hours" must be a non-empty array' };
  }

  const parsed: number[] = [];
  for (const entry of value) {
    const numeric = toFiniteNumber(entry);
    if (numeric === null || !Number.isInteger(numeric)) {
      return {
        hours: [],
        warnings,
        error: `"hours" contains a non-integer value (${JSON.stringify(entry)})`,
      };
    }
    if (numeric < MIN_HOUR || numeric > MAX_HOUR) {
      return {
        hours: [],
        warnings,
        error: `"hours" contains ${numeric}, outside the allowed range ${MIN_HOUR}-${MAX_HOUR}`,
      };
    }
    parsed.push(numeric);
  }

  const unique = [...new Set(parsed)];
  if (unique.length !== parsed.length) {
    warnings.push('duplicate hours were removed');
  }

  const sorted = [...unique].sort((a, b) => a - b);
  if (sorted.some((hour, index) => hour !== unique[index])) {
    warnings.push('hours were re-sorted into ascending order');
  }

  const horizonSet = new Set(horizon);
  const inHorizon = sorted.filter((hour) => horizonSet.has(hour));
  if (inHorizon.length !== sorted.length) {
    warnings.push(
      `hours outside the scenario horizon were dropped (${sorted
        .filter((hour) => !horizonSet.has(hour))
        .join(', ')})`,
    );
  }

  if (inHorizon.length === 0) {
    return {
      hours: [],
      warnings,
      error: 'no requested hour exists in the scenario horizon',
    };
  }

  return { hours: inHorizon, warnings };
}

/**
 * Accepts either a fraction in [0,1] or a percentage in (1,100] and returns a
 * fraction. Models phrase "20% less" as both 0.2 and 20.
 */
export function toFraction(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 0) return null;
  if (numeric <= 1) return numeric;
  if (numeric <= 100) return numeric / 100;
  return null;
}
