"use client";

import { DemandSolarChart, TariffChart } from "@/components/charts/input-charts";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatHour, formatNumber } from "@/lib/format";
import { sum } from "@/lib/plan";
import type { HourInput } from "@/lib/types";

interface EnergyDataViewerProps {
  hours: HourInput[];
  onChange: (hour: number, patch: Partial<HourInput>) => void;
}

/** Numeric cell that keeps the table editable without fighting the keyboard. */
function NumberCell({
  value,
  onCommit,
  step = 1,
  label,
}: {
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  label: string;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      step={step}
      value={value}
      aria-label={label}
      onChange={(event) => {
        const next = Number(event.target.value);
        // An empty or half-typed value must not wipe the scenario.
        if (Number.isFinite(next) && next >= 0) onCommit(next);
      }}
      className="tabular h-8 w-24 text-right text-xs"
    />
  );
}

export function EnergyDataViewer({ hours, onChange }: EnergyDataViewerProps) {
  const totalDemand = sum(hours.map((hour) => hour.demand_kwh));
  const totalSolar = sum(hours.map((hour) => hour.solar_kwh));
  const averageTariff =
    hours.length > 0
      ? sum(hours.map((hour) => hour.tariff_bdt_per_kwh)) / hours.length
      : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <DemandSolarChart hours={hours} />
        <TariffChart hours={hours} />
      </div>

      <Card className="overflow-hidden py-0">
        <div className="text-muted-foreground bg-muted/40 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 text-xs">
          <span>
            Demand{" "}
            <span className="tabular text-foreground font-medium">
              {formatNumber(totalDemand)} kWh
            </span>
          </span>
          <span>
            Solar{" "}
            <span className="tabular text-foreground font-medium">
              {formatNumber(totalSolar)} kWh
            </span>
          </span>
          <span>
            Average tariff{" "}
            <span className="tabular text-foreground font-medium">
              {formatNumber(averageTariff, true)} BDT/kWh
            </span>
          </span>
          <span className="ml-auto">Values are editable.</span>
        </div>

        <CardContent className="max-h-[26rem] overflow-auto p-0">
          <Table>
            <TableHeader className="bg-card sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-20">Hour</TableHead>
                <TableHead className="text-right">Demand (kWh)</TableHead>
                <TableHead className="text-right">Solar (kWh)</TableHead>
                <TableHead className="text-right">Tariff (BDT/kWh)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hours.map((row) => (
                <TableRow key={row.hour}>
                  <TableCell className="tabular text-muted-foreground text-xs">
                    {formatHour(row.hour)}
                  </TableCell>
                  <TableCell className="text-right">
                    <NumberCell
                      value={row.demand_kwh}
                      label={`Demand at ${formatHour(row.hour)}`}
                      onCommit={(value) =>
                        onChange(row.hour, { demand_kwh: value })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <NumberCell
                      value={row.solar_kwh}
                      label={`Solar at ${formatHour(row.hour)}`}
                      onCommit={(value) =>
                        onChange(row.hour, { solar_kwh: value })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <NumberCell
                      value={row.tariff_bdt_per_kwh}
                      step={0.1}
                      label={`Tariff at ${formatHour(row.hour)}`}
                      onCommit={(value) =>
                        onChange(row.hour, { tariff_bdt_per_kwh: value })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
