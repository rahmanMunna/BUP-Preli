"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFrame } from "@/components/charts/chart-frame";
import { TOOLTIP_CURSOR, VizTooltip } from "@/components/charts/viz-tooltip";
import { formatNumber } from "@/lib/format";
import { formatHourShort } from "@/lib/format";
import type { HourInput } from "@/lib/types";
import { AXIS, CHART_MARGIN, GRID, MARK, SERIES } from "@/lib/viz";

interface InputChartProps {
  hours: HourInput[];
}

/**
 * Demand and solar share one kWh axis, so they belong on one chart. The
 * tariff is BDT/kWh — a different unit — so it gets its own chart below
 * rather than a second y-axis.
 */
export function DemandSolarChart({ hours }: InputChartProps) {
  return (
    <ChartFrame
      title="Demand and solar"
      description="Campus load against forecast on-site generation"
      legend={[
        { label: "Demand", color: SERIES.demand.color },
        { label: "Solar forecast", color: SERIES.solar.color },
      ]}
    >
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={hours} margin={CHART_MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="hour"
            tickFormatter={formatHourShort}
            interval={2}
            {...AXIS}
          />
          <YAxis width={44} {...AXIS} />
          <Tooltip
            cursor={TOOLTIP_CURSOR}
            content={
              <VizTooltip
                format={(value) => `${formatNumber(value, true)} kWh`}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="solar_kwh"
            name="Solar forecast"
            stroke={SERIES.solar.color}
            strokeWidth={MARK.strokeWidth}
            fill={SERIES.solar.color}
            fillOpacity={MARK.areaOpacity}
          />
          <Line
            type="monotone"
            dataKey="demand_kwh"
            name="Demand"
            stroke={SERIES.demand.color}
            strokeWidth={MARK.strokeWidth}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Tariff is a step function — it holds a price for a band of hours. */
export function TariffChart({ hours }: InputChartProps) {
  return (
    <ChartFrame
      title="Tariff"
      description="Price of grid energy through the day (BDT per kWh)"
    >
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={hours} margin={CHART_MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="hour"
            tickFormatter={formatHourShort}
            interval={2}
            {...AXIS}
          />
          <YAxis width={44} {...AXIS} />
          <Tooltip
            cursor={TOOLTIP_CURSOR}
            content={
              <VizTooltip
                format={(value) => `${formatNumber(value, true)} BDT/kWh`}
              />
            }
          />
          <Line
            type="stepAfter"
            dataKey="tariff_bdt_per_kwh"
            name="Tariff"
            stroke={SERIES.grid.color}
            strokeWidth={MARK.strokeWidth}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
