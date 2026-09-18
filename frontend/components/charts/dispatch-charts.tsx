"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFrame } from "@/components/charts/chart-frame";
import {
  BAR_CURSOR,
  TOOLTIP_CURSOR,
  VizTooltip,
} from "@/components/charts/viz-tooltip";
import { formatBdt, formatHour, formatHourShort, formatNumber } from "@/lib/format";
import { peakHour } from "@/lib/plan";
import type { BatteryInput, HourlyPlanEntry } from "@/lib/types";
import { AXIS, CHART_HEIGHT, CHART_MARGIN, GRID, MARK, SERIES } from "@/lib/viz";

interface ChartProps {
  plan: HourlyPlanEntry[];
}

const kwh = (value: number) => `${formatNumber(value, true)} kWh`;

/**
 * Where every kWh of supply came from, hour by hour.
 *
 * Stacked because the three sources sum to something meaningful (demand plus
 * whatever went into the battery), with demand drawn over the top as a neutral
 * reference line so over- and under-supply are visible.
 */
export function EnergyMixChart({ plan }: ChartProps) {
  return (
    <ChartFrame
      title="Supply mix"
      description="Where each hour's energy comes from, against campus demand"
      legend={[
        { label: SERIES.solar.label + " used", color: SERIES.solar.color },
        { label: "Battery discharge", color: SERIES.battery.color },
        { label: SERIES.grid.label, color: SERIES.grid.color },
        { label: SERIES.demand.label, color: SERIES.demand.color },
      ]}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={plan} margin={CHART_MARGIN}>
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
            content={<VizTooltip format={(value) => kwh(value)} />}
          />
          <Area
            type="monotone"
            dataKey="solar_used_kwh"
            name="Solar used"
            stackId="supply"
            stroke={SERIES.solar.color}
            strokeWidth={MARK.strokeWidth}
            fill={SERIES.solar.color}
            fillOpacity={MARK.areaOpacity}
          />
          <Area
            type="monotone"
            dataKey="battery_discharge_kwh"
            name="Battery discharge"
            stackId="supply"
            stroke={SERIES.battery.color}
            strokeWidth={MARK.strokeWidth}
            fill={SERIES.battery.color}
            fillOpacity={MARK.areaOpacity}
          />
          <Area
            type="monotone"
            dataKey="grid_kwh"
            name="Grid import"
            stackId="supply"
            stroke={SERIES.grid.color}
            strokeWidth={MARK.strokeWidth}
            fill={SERIES.grid.color}
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

/** Grid import per hour, with the peak called out — the number judges score. */
export function GridConsumptionChart({ plan }: ChartProps) {
  const peak = peakHour(plan);

  return (
    <ChartFrame
      title="Grid consumption"
      description="Energy bought from the utility each hour"
      footnote={
        peak ? (
          <>
            Peak import <span className="tabular">{kwh(peak.grid_kwh)}</span> at{" "}
            {formatHour(peak.hour)}.
          </>
        ) : null
      }
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={plan} margin={CHART_MARGIN} barCategoryGap={2}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="hour"
            tickFormatter={formatHourShort}
            interval={2}
            {...AXIS}
          />
          <YAxis width={44} {...AXIS} />
          <Tooltip
            cursor={BAR_CURSOR}
            content={
              <VizTooltip
                format={(value) => kwh(value)}
                extra={(row) => [
                  ["Cost", formatBdt(Number(row.cost_bdt ?? 0), true)],
                  [
                    "Tariff",
                    `${formatNumber(Number(row.tariff_bdt_per_kwh ?? 0), true)} BDT/kWh`,
                  ],
                ]}
              />
            }
          />
          {peak ? (
            <ReferenceLine
              y={peak.grid_kwh}
              stroke={SERIES.demand.color}
              strokeWidth={1}
              label={{
                value: `peak ${formatNumber(peak.grid_kwh)}`,
                position: "insideTopLeft",
                fill: "var(--viz-muted)",
                fontSize: 11,
              }}
            />
          ) : null}
          <Bar
            dataKey="grid_kwh"
            name="Grid import"
            fill={SERIES.grid.color}
            radius={MARK.barRadius}
            maxBarSize={MARK.maxBarSize}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

interface SolarChartProps extends ChartProps {
  /** Pre-directive solar, so a `solar_reduction` is visible as a shortfall. */
  availableBefore?: Map<number, number>;
}

/** Solar actually consumed against what the array offered. */
export function SolarUsageChart({ plan, availableBefore }: SolarChartProps) {
  const data = plan.map((row) => ({
    ...row,
    solar_forecast_kwh: availableBefore?.get(row.hour) ?? row.solar_kwh,
  }));

  const curtailed = data.reduce(
    (total, row) => total + Math.max(0, row.solar_kwh - row.solar_used_kwh),
    0,
  );

  return (
    <ChartFrame
      title="Solar usage"
      description="On-site generation and how much of it served demand"
      legend={[
        { label: "Available", color: SERIES.demand.color },
        { label: "Used", color: SERIES.solar.color },
      ]}
      footnote={
        curtailed > 0.05 ? (
          <>
            <span className="tabular">{kwh(curtailed)}</span> of available solar
            could not be used or stored.
          </>
        ) : (
          "Every available kWh of solar was used or stored."
        )
      }
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={data} margin={CHART_MARGIN}>
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
            content={<VizTooltip format={(value) => kwh(value)} />}
          />
          <Line
            type="monotone"
            dataKey="solar_kwh"
            name="Available"
            stroke={SERIES.demand.color}
            strokeWidth={MARK.strokeWidth}
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="solar_used_kwh"
            name="Used"
            stroke={SERIES.solar.color}
            strokeWidth={MARK.strokeWidth}
            fill={SERIES.solar.color}
            fillOpacity={MARK.areaOpacity}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

interface BatteryChartProps extends ChartProps {
  battery: BatteryInput;
}

/** State of charge across the day, against its capacity and reserve floor. */
export function BatteryLevelChart({ plan, battery }: BatteryChartProps) {
  const reserve = battery.min_reserve_kwh;

  return (
    <ChartFrame
      title="Battery level"
      description="Stored energy at the end of each hour"
      footnote={
        <>
          Capacity <span className="tabular">{kwh(battery.capacity_kwh)}</span>
          {reserve > 0 ? (
            <>
              {" · "}reserve floor{" "}
              <span className="tabular">{kwh(reserve)}</span>
            </>
          ) : null}
        </>
      }
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={plan} margin={CHART_MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="hour"
            tickFormatter={formatHourShort}
            interval={2}
            {...AXIS}
          />
          <YAxis
            width={44}
            domain={[0, Math.ceil(battery.capacity_kwh)]}
            {...AXIS}
          />
          <Tooltip
            cursor={TOOLTIP_CURSOR}
            content={
              <VizTooltip
                format={(value) => kwh(value)}
                extra={(row) => [
                  ["Charged", kwh(Number(row.battery_charge_kwh ?? 0))],
                  ["Discharged", kwh(Number(row.battery_discharge_kwh ?? 0))],
                ]}
              />
            }
          />
          {reserve > 0 ? (
            <ReferenceLine
              y={reserve}
              stroke={SERIES.demand.color}
              strokeWidth={1}
              label={{
                value: "reserve",
                position: "insideBottomLeft",
                fill: "var(--viz-muted)",
                fontSize: 11,
              }}
            />
          ) : null}
          <Area
            type="monotone"
            dataKey="battery_soc_kwh"
            name="Stored energy"
            stroke={SERIES.battery.color}
            strokeWidth={MARK.strokeWidth}
            fill={SERIES.battery.color}
            fillOpacity={MARK.areaOpacity}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Hourly spend — where the money actually goes. */
export function CostChart({ plan }: ChartProps) {
  const dearest = plan.reduce(
    (best, row) => (row.cost_bdt > best.cost_bdt ? row : best),
    plan[0],
  );

  return (
    <ChartFrame
      title="Hourly cost"
      description="Grid import priced at that hour's tariff"
      footnote={
        dearest ? (
          <>
            Most expensive hour {formatHour(dearest.hour)} at{" "}
            <span className="tabular">{formatBdt(dearest.cost_bdt, true)}</span>.
          </>
        ) : null
      }
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={plan} margin={CHART_MARGIN} barCategoryGap={2}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="hour"
            tickFormatter={formatHourShort}
            interval={2}
            {...AXIS}
          />
          <YAxis width={52} {...AXIS} />
          <Tooltip
            cursor={BAR_CURSOR}
            content={
              <VizTooltip
                format={(value) => formatBdt(value, true)}
                extra={(row) => [
                  ["Grid import", kwh(Number(row.grid_kwh ?? 0))],
                  [
                    "Tariff",
                    `${formatNumber(Number(row.tariff_bdt_per_kwh ?? 0), true)} BDT/kWh`,
                  ],
                ]}
              />
            }
          />
          <Bar
            dataKey="cost_bdt"
            name="Cost"
            fill={SERIES.grid.color}
            radius={MARK.barRadius}
            maxBarSize={MARK.maxBarSize}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
