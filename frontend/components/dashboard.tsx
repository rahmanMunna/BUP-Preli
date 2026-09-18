"use client";

import { useCallback, useMemo, useState } from "react";
import { ApiStatus } from "@/components/api-status";
import {
  BatteryLevelChart,
  CostChart,
  EnergyMixChart,
  GridConsumptionChart,
  SolarUsageChart,
} from "@/components/charts/dispatch-charts";
import { DirectiveViewer } from "@/components/directive-viewer";
import { EnergyDataViewer } from "@/components/energy-data-viewer";
import { PlanTable } from "@/components/plan-table";
import { ScenarioForm } from "@/components/scenario-form";
import { SummaryCards } from "@/components/summary-cards";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOptimize } from "@/hooks/use-optimize";
import { useScenario } from "@/hooks/use-scenario";
import { baselineCost, baselinePeak, summarizeBattery, sum } from "@/lib/plan";

export function Dashboard() {
  const scenario = useScenario();
  const optimize = useOptimize();
  const [tab, setTab] = useState("plan");

  const { data, error, isLoading, durationMs, run } = optimize;

  const runOptimize = useCallback(async () => {
    const result = await run(scenario.toRequest());
    if (result) setTab("plan");
  }, [run, scenario]);

  /** Solar as forecast, before any directive trimmed it. */
  const solarBefore = useMemo(
    () =>
      new Map(
        scenario.scenario.hours.map((hour) => [hour.hour, hour.solar_kwh]),
      ),
    [scenario.scenario.hours],
  );

  const baseline = useMemo(
    () => ({
      cost: baselineCost(scenario.scenario.hours),
      peak: baselinePeak(scenario.scenario.hours),
      grid: sum(
        scenario.scenario.hours.map((hour) =>
          Math.max(0, hour.demand_kwh - hour.solar_kwh),
        ),
      ),
    }),
    [scenario.scenario.hours],
  );

  const batterySummary = useMemo(
    () =>
      data ? summarizeBattery(data.hourly_plan, scenario.scenario.battery) : null,
    [data, scenario.scenario.battery],
  );

  const showResults = Boolean(data);

  return (
    <div className="min-h-screen">
      <header className="bg-card/80 sticky top-0 z-30 border-b backdrop-blur">
        <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold sm:text-base">
              GridWise · Smart Campus Energy Optimization
            </h1>
            <p className="text-muted-foreground truncate text-xs">
              BUP CSE FEST 2026 · operator notes to an optimized 24-hour
              dispatch plan
            </p>
          </div>
          <ApiStatus />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-[110rem] px-4 py-5 sm:px-6">
        <div className="grid gap-5 lg:grid-cols-12">
          <aside className="lg:col-span-4 xl:col-span-3">
            <div className="lg:sticky lg:top-20">
              <ScenarioForm
                scenarioId={scenario.scenario.scenarioId}
                notes={scenario.scenario.notes}
                battery={scenario.scenario.battery}
                isLoading={isLoading}
                onScenarioIdChange={scenario.setScenarioId}
                onNoteChange={scenario.updateNote}
                onNoteAdd={scenario.addNote}
                onNoteRemove={scenario.removeNote}
                onBatteryChange={scenario.updateBattery}
                onReset={scenario.reset}
                onSubmit={runOptimize}
              />
            </div>
          </aside>

          <section className="space-y-4 lg:col-span-8 xl:col-span-9">
            {error ? (
              <ErrorState
                error={error}
                onRetry={runOptimize}
                isRetrying={isLoading}
              />
            ) : null}

            {isLoading && !showResults ? <LoadingState /> : null}

            {!isLoading && !showResults && !error ? (
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="plan">Dispatch plan</TabsTrigger>
                  <TabsTrigger value="input">Energy data</TabsTrigger>
                </TabsList>
                <TabsContent value="plan" className="mt-4">
                  <EmptyState onOptimize={runOptimize} />
                </TabsContent>
                <TabsContent value="input" className="mt-4">
                  <EnergyDataViewer
                    hours={scenario.scenario.hours}
                    onChange={scenario.updateHour}
                  />
                </TabsContent>
              </Tabs>
            ) : null}

            {showResults && data ? (
              <>
                <SummaryCards
                  totalGridKwh={data.total_grid_kwh}
                  totalCostBdt={data.total_cost_bdt}
                  peakGridKwh={data.peak_grid_kwh}
                  battery={batterySummary}
                  baseline={baseline}
                />

                {data.plan_summary ? (
                  <Card>
                    <CardContent className="p-4">
                      <p className="text-sm leading-relaxed">
                        {data.plan_summary}
                      </p>
                      <p className="text-muted-foreground mt-2 text-xs">
                        Scenario{" "}
                        <span className="font-mono">{data.scenario_id}</span>
                        {durationMs !== null ? (
                          <> · answered in {(durationMs / 1000).toFixed(1)}s</>
                        ) : null}
                        {isLoading ? <> · refreshing…</> : null}
                      </p>
                    </CardContent>
                  </Card>
                ) : null}

                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="plan">Dispatch plan</TabsTrigger>
                    <TabsTrigger value="directives">
                      Directives ({data.directive_interpretation.length})
                    </TabsTrigger>
                    <TabsTrigger value="input">Energy data</TabsTrigger>
                    <TabsTrigger value="table">Schedule table</TabsTrigger>
                  </TabsList>

                  <TabsContent value="plan" className="mt-4">
                    <div className="grid gap-4 xl:grid-cols-2">
                      <EnergyMixChart plan={data.hourly_plan} />
                      <GridConsumptionChart plan={data.hourly_plan} />
                      <BatteryLevelChart
                        plan={data.hourly_plan}
                        battery={scenario.scenario.battery}
                      />
                      <CostChart plan={data.hourly_plan} />
                      <SolarUsageChart
                        plan={data.hourly_plan}
                        availableBefore={solarBefore}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="directives" className="mt-4">
                    <DirectiveViewer
                      directives={data.directive_interpretation}
                      notes={scenario.scenario.notes.filter(
                        (note) => note.trim().length > 0,
                      )}
                    />
                  </TabsContent>

                  <TabsContent value="input" className="mt-4">
                    <EnergyDataViewer
                      hours={scenario.scenario.hours}
                      onChange={scenario.updateHour}
                    />
                  </TabsContent>

                  <TabsContent value="table" className="mt-4">
                    <PlanTable plan={data.hourly_plan} />
                  </TabsContent>
                </Tabs>
              </>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}
