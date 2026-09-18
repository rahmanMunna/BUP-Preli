/** Display formatting. Every number the user sees goes through here. */

const kwh = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

const kwhPrecise = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const bdt = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const bdtPrecise = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatKwh(value: number, precise = false): string {
  return `${(precise ? kwhPrecise : kwh).format(value)} kWh`;
}

export function formatNumber(value: number, precise = false): string {
  return (precise ? kwhPrecise : kwh).format(value);
}

export function formatBdt(value: number, precise = false): string {
  return `BDT ${(precise ? bdtPrecise : bdt).format(value)}`;
}

/** Hour index to a 24-hour clock label: 9 -> "09:00". */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Compact axis label: 9 -> "09". */
export function formatHourShort(hour: number): string {
  return String(hour).padStart(2, "0");
}

/** "13, 14 and 15" — reads better than a bare array in directive copy. */
export function formatHourList(hours: number[]): string {
  const labels = hours.map(formatHour);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function formatDirectiveType(type: string): string {
  return type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
