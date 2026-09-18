"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBdt, formatHour, formatNumber } from "@/lib/format";
import { sum } from "@/lib/plan";
import type { HourlyPlanEntry } from "@/lib/types";

/**
 * The schedule as numbers.
 *
 * Not a fallback — it is the accessible companion to the charts, and the view
 * anyone checking the optimizer's arithmetic will actually use.
 */
export function PlanTable({ plan }: { plan: HourlyPlanEntry[] }) {
  const totals = {
    demand: sum(plan.map((row) => row.demand_kwh)),
    solar: sum(plan.map((row) => row.solar_used_kwh)),
    charge: sum(plan.map((row) => row.battery_charge_kwh)),
    discharge: sum(plan.map((row) => row.battery_discharge_kwh)),
    grid: sum(plan.map((row) => row.grid_kwh)),
    cost: sum(plan.map((row) => row.cost_bdt)),
  };

  return (
    <Card className="overflow-hidden py-0">
      <CardContent className="max-h-[32rem] overflow-auto p-0">
        <Table>
          <TableHeader className="bg-card sticky top-0 z-10">
            <TableRow>
              <TableHead className="w-20">Hour</TableHead>
              <TableHead className="text-right">Demand</TableHead>
              <TableHead className="text-right">Solar used</TableHead>
              <TableHead className="text-right">Charge</TableHead>
              <TableHead className="text-right">Discharge</TableHead>
              <TableHead className="text-right">Battery</TableHead>
              <TableHead className="text-right">Grid</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="tabular text-xs">
            {plan.map((row) => (
              <TableRow key={row.hour}>
                <TableCell className="text-muted-foreground">
                  {formatHour(row.hour)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.demand_kwh, true)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.solar_used_kwh, true)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.battery_charge_kwh, true)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.battery_discharge_kwh, true)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.battery_soc_kwh, true)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatNumber(row.grid_kwh, true)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(row.cost_bdt, true)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="bg-card sticky bottom-0">
            <TableRow className="tabular text-xs">
              <TableCell className="font-medium">Total</TableCell>
              <TableCell className="text-right">
                {formatNumber(totals.demand)}
              </TableCell>
              <TableCell className="text-right">
                {formatNumber(totals.solar)}
              </TableCell>
              <TableCell className="text-right">
                {formatNumber(totals.charge)}
              </TableCell>
              <TableCell className="text-right">
                {formatNumber(totals.discharge)}
              </TableCell>
              <TableCell className="text-muted-foreground text-right">
                —
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatNumber(totals.grid)}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatBdt(totals.cost)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
