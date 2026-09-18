"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBdt, formatKwh, formatPercent } from "@/lib/format";
import type { BatterySummary } from "@/lib/plan";
import { cn } from "@/lib/utils";

interface StatTileProps {
  label: string;
  value: string;
  /** Signed change against the no-battery baseline; negative is good here. */
  delta?: number | null;
  caption?: string;
  /** Lower is better for cost, grid and peak — true for every tile but battery. */
  lowerIsBetter?: boolean;
}

function StatTile({
  label,
  value,
  delta,
  caption,
  lowerIsBetter = true,
}: StatTileProps) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const improved = hasDelta && (lowerIsBetter ? delta < 0 : delta > 0);
  const unchanged = hasDelta && Math.abs(delta) < 0.005;
  const Icon = unchanged ? Minus : delta && delta < 0 ? ArrowDownRight : ArrowUpRight;

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className="mt-1 text-2xl leading-tight font-semibold">{value}</p>

        {hasDelta ? (
          <p
            className={cn(
              "mt-1.5 flex items-center gap-1 text-xs font-medium",
              unchanged
                ? "text-muted-foreground"
                : improved
                  ? "text-status-good"
                  : "text-status-critical",
            )}
          >
            {/* Icon + wording carry the meaning; colour only reinforces it. */}
            <Icon aria-hidden className="size-3.5" />
            {unchanged
              ? "no change"
              : `${formatPercent(Math.abs(delta))} ${delta < 0 ? "lower" : "higher"}`}
            <span className="text-muted-foreground font-normal">
              than unmanaged
            </span>
          </p>
        ) : caption ? (
          <p className="text-muted-foreground mt-1.5 text-xs">{caption}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SummaryCardsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index}>
          <CardContent className="space-y-2 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface SummaryCardsProps {
  totalGridKwh: number;
  totalCostBdt: number;
  peakGridKwh: number;
  battery: BatterySummary | null;
  baseline: { cost: number; peak: number; grid: number };
}

export function SummaryCards({
  totalGridKwh,
  totalCostBdt,
  peakGridKwh,
  battery,
  baseline,
}: SummaryCardsProps) {
  const ratio = (actual: number, base: number) =>
    base > 0 ? (actual - base) / base : null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="Total grid energy"
        value={formatKwh(totalGridKwh)}
        delta={ratio(totalGridKwh, baseline.grid)}
      />
      <StatTile
        label="Total cost"
        value={formatBdt(totalCostBdt)}
        delta={ratio(totalCostBdt, baseline.cost)}
      />
      <StatTile
        label="Peak grid draw"
        value={formatKwh(peakGridKwh)}
        delta={ratio(peakGridKwh, baseline.peak)}
      />
      <StatTile
        label="Battery at end of day"
        value={battery ? formatKwh(battery.endSoc) : "—"}
        caption={
          battery
            ? `${formatPercent(battery.endFraction)} charged · ${
                battery.isNeutral
                  ? "back to its starting level"
                  : `started at ${formatKwh(battery.startSoc)}`
              }`
            : undefined
        }
      />
    </div>
  );
}
