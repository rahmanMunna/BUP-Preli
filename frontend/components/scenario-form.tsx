"use client";

import { Loader2, Plus, RotateCcw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { BatteryInput } from "@/lib/types";

interface ScenarioFormProps {
  scenarioId: string;
  notes: string[];
  battery: BatteryInput;
  isLoading: boolean;
  onScenarioIdChange: (value: string) => void;
  onNoteChange: (index: number, value: string) => void;
  onNoteAdd: () => void;
  onNoteRemove: (index: number) => void;
  onBatteryChange: (patch: Partial<BatteryInput>) => void;
  onReset: () => void;
  onSubmit: () => void;
}

const BATTERY_FIELDS: Array<{
  key: keyof BatteryInput;
  label: string;
  step?: number;
  max?: number;
}> = [
  { key: "capacity_kwh", label: "Capacity (kWh)" },
  { key: "initial_soc_kwh", label: "Starting charge (kWh)" },
  { key: "max_charge_kwh", label: "Max charge / h (kWh)" },
  { key: "max_discharge_kwh", label: "Max discharge / h (kWh)" },
  { key: "efficiency", label: "Charge efficiency", step: 0.01, max: 1 },
  { key: "min_reserve_kwh", label: "Reserve floor (kWh)" },
];

export function ScenarioForm({
  scenarioId,
  notes,
  battery,
  isLoading,
  onScenarioIdChange,
  onNoteChange,
  onNoteAdd,
  onNoteRemove,
  onBatteryChange,
  onReset,
  onSubmit,
}: ScenarioFormProps) {
  const filledNotes = notes.filter((note) => note.trim().length > 0).length;

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="text-sm font-semibold">Scenario</CardTitle>
        <CardDescription className="text-xs">
          Operator notes are written in plain English — the interpreter turns
          them into directives.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="scenario-id" className="text-xs">
            Scenario ID
          </Label>
          <Input
            id="scenario-id"
            value={scenarioId}
            onChange={(event) => onScenarioIdChange(event.target.value)}
            placeholder="bup-campus-day-1"
            className="h-9 text-sm"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              Operator notes{" "}
              <span className="text-muted-foreground tabular font-normal">
                ({filledNotes})
              </span>
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onNoteAdd}
              className="h-7 px-2 text-xs"
            >
              <Plus aria-hidden className="size-3.5" />
              Add note
            </Button>
          </div>

          {notes.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
              No notes. The optimizer will run unconstrained — add a note to see
              a directive applied.
            </p>
          ) : (
            <ul className="space-y-2">
              {notes.map((note, index) => (
                <li key={index} className="flex items-start gap-1.5">
                  <Textarea
                    value={note}
                    rows={2}
                    onChange={(event) => onNoteChange(index, event.target.value)}
                    placeholder="e.g. keep a quarter of the battery in reserve after sunset"
                    aria-label={`Operator note ${index + 1}`}
                    className="min-h-[3.5rem] resize-y text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onNoteRemove(index)}
                    aria-label={`Remove note ${index + 1}`}
                    className="text-muted-foreground hover:text-foreground mt-0.5 size-8 shrink-0"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Separator />

        <div className="space-y-2">
          <Label className="text-xs">Battery</Label>
          <div className="grid grid-cols-2 gap-2">
            {BATTERY_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label
                  htmlFor={`battery-${field.key}`}
                  className="text-muted-foreground text-[11px] font-normal"
                >
                  {field.label}
                </Label>
                <Input
                  id={`battery-${field.key}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={field.max}
                  step={field.step ?? 1}
                  value={battery[field.key]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value >= 0) {
                      onBatteryChange({ [field.key]: value });
                    }
                  }}
                  className="tabular h-8 text-xs"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={onSubmit}
            disabled={isLoading}
            className="w-full"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin" />
                Optimizing…
              </>
            ) : (
              <>
                <Zap aria-hidden className="size-4" />
                Optimize energy
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={isLoading}
            className="text-muted-foreground w-full text-xs"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            Reset to sample scenario
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
