"use client";

import { formatHour } from "@/lib/format";

interface TooltipEntry {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
  payload?: Record<string, unknown>;
}

interface VizTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipEntry[];
  /** Per-series value formatting; defaults to kWh. */
  format?: (value: number, key: string) => string;
  /** Rows to append after the series, e.g. a derived total. */
  extra?: (payload: Record<string, unknown>) => Array<[string, string]>;
}

/**
 * One tooltip for every chart on the dashboard.
 *
 * Values are tabular so the numbers line up as the crosshair moves, and the
 * identity swatch sits beside the label rather than colouring the text.
 */
export function VizTooltip({
  active,
  label,
  payload,
  format,
  extra,
}: VizTooltipProps) {
  if (!active || !payload?.length) return null;

  const rows = payload.filter(
    (entry) => typeof entry.value === "number" && Number.isFinite(entry.value),
  );
  if (rows.length === 0) return null;

  const source = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  const extras = extra?.(source) ?? [];

  return (
    <div className="bg-popover text-popover-foreground min-w-[11rem] rounded-lg border p-2.5 shadow-md">
      <p className="mb-1.5 text-xs font-medium">
        {typeof label === "number" ? formatHour(label) : label}
      </p>

      <dl className="space-y-1">
        {rows.map((entry) => (
          <div
            key={String(entry.dataKey ?? entry.name)}
            className="flex items-center justify-between gap-4 text-xs"
          >
            <dt className="text-muted-foreground flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="truncate">{entry.name}</span>
            </dt>
            <dd className="tabular font-medium">
              {format
                ? format(entry.value as number, String(entry.dataKey ?? ""))
                : `${(entry.value as number).toFixed(1)} kWh`}
            </dd>
          </div>
        ))}

        {extras.map(([key, value]) => (
          <div
            key={key}
            className="text-muted-foreground flex items-center justify-between gap-4 border-t pt-1 text-xs"
          >
            <dt>{key}</dt>
            <dd className="tabular font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Crosshair styling shared by the time-series charts. */
export const TOOLTIP_CURSOR = {
  stroke: "var(--viz-axis)",
  strokeWidth: 1,
} as const;

/** Bar charts get a wash instead of a line, so the hit target reads. */
export const BAR_CURSOR = { fill: "var(--viz-grid)", fillOpacity: 0.45 } as const;
