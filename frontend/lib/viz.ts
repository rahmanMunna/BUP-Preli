/**
 * Chart constants shared by every figure on the dashboard.
 *
 * Colour is assigned per ENTITY, not per chart position, so grid import is the
 * same blue everywhere and a chart that drops a series never repaints the
 * survivors. The three hues are categorical slots 1-3 of the validated
 * palette; demand is deliberately neutral ink because it is a reference line,
 * not a fourth category.
 */

export const SERIES = {
  grid: { label: "Grid import", color: "var(--viz-grid-series)" },
  battery: { label: "Battery", color: "var(--viz-battery)" },
  solar: { label: "Solar", color: "var(--viz-solar)" },
  demand: { label: "Demand", color: "var(--viz-reference)" },
} as const;

export type SeriesKey = keyof typeof SERIES;

/** 2px lines, >=8px markers, 10% area washes — the house mark specs. */
export const MARK = {
  strokeWidth: 2,
  areaOpacity: 0.1,
  dotRadius: 4,
  maxBarSize: 24,
  /** Rounded data-end, square at the baseline. */
  barRadius: [4, 4, 0, 0] as [number, number, number, number],
} as const;

export const AXIS = {
  tick: { fill: "var(--viz-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--viz-axis)" },
} as const;

export const GRID = {
  stroke: "var(--viz-grid)",
  strokeWidth: 1,
  vertical: false,
} as const;

export const CHART_HEIGHT = 260;
export const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
