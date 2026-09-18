"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SAMPLE_BATTERY,
  SAMPLE_HOURS,
  SAMPLE_NOTES,
  SAMPLE_SCENARIO_ID,
} from "@/lib/sample-data";
import type { BatteryInput, HourInput, OptimizeRequest } from "@/lib/types";

const STORAGE_KEY = "gridwise.scenario.v1";

export interface ScenarioState {
  scenarioId: string;
  notes: string[];
  hours: HourInput[];
  battery: BatteryInput;
}

function initialScenario(): ScenarioState {
  return {
    scenarioId: SAMPLE_SCENARIO_ID,
    notes: [...SAMPLE_NOTES],
    hours: SAMPLE_HOURS.map((hour) => ({ ...hour })),
    battery: { ...SAMPLE_BATTERY },
  };
}

/**
 * Holds the scenario being edited.
 *
 * Restored from localStorage so a page reload mid-demo does not lose the notes
 * someone just typed; reads are defensive because a stale or hand-edited entry
 * must never break the dashboard.
 */
export function useScenario() {
  const [scenario, setScenario] = useState<ScenarioState>(initialScenario);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ScenarioState>;
        if (
          Array.isArray(parsed.hours) &&
          parsed.hours.length > 0 &&
          Array.isArray(parsed.notes) &&
          parsed.battery
        ) {
          setScenario({
            scenarioId: parsed.scenarioId ?? SAMPLE_SCENARIO_ID,
            notes: parsed.notes,
            hours: parsed.hours as HourInput[],
            battery: parsed.battery as BatteryInput,
          });
        }
      }
    } catch {
      // Corrupt entry: keep the sample scenario.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
    } catch {
      // Private mode or a full quota: persistence is a convenience, not a need.
    }
  }, [scenario, restored]);

  const setScenarioId = useCallback((scenarioId: string) => {
    setScenario((previous) => ({ ...previous, scenarioId }));
  }, []);

  const setNotes = useCallback((notes: string[]) => {
    setScenario((previous) => ({ ...previous, notes }));
  }, []);

  const updateNote = useCallback((index: number, text: string) => {
    setScenario((previous) => ({
      ...previous,
      notes: previous.notes.map((note, i) => (i === index ? text : note)),
    }));
  }, []);

  const addNote = useCallback(() => {
    setScenario((previous) => ({ ...previous, notes: [...previous.notes, ""] }));
  }, []);

  const removeNote = useCallback((index: number) => {
    setScenario((previous) => ({
      ...previous,
      notes: previous.notes.filter((_, i) => i !== index),
    }));
  }, []);

  const updateHour = useCallback(
    (hour: number, patch: Partial<HourInput>) => {
      setScenario((previous) => ({
        ...previous,
        hours: previous.hours.map((row) =>
          row.hour === hour ? { ...row, ...patch } : row,
        ),
      }));
    },
    [],
  );

  const updateBattery = useCallback((patch: Partial<BatteryInput>) => {
    setScenario((previous) => ({
      ...previous,
      battery: { ...previous.battery, ...patch },
    }));
  }, []);

  const reset = useCallback(() => setScenario(initialScenario()), []);

  /** The payload exactly as `POST /optimize-energy` expects it. */
  const toRequest = useCallback((): OptimizeRequest => {
    return {
      scenario_id: scenario.scenarioId.trim() || SAMPLE_SCENARIO_ID,
      // Blank rows are editing artefacts, not instructions.
      operator_notes: scenario.notes
        .map((note) => note.trim())
        .filter((note) => note.length > 0),
      hours: [...scenario.hours].sort((a, b) => a.hour - b.hour),
      battery: scenario.battery,
    };
  }, [scenario]);

  return {
    scenario,
    restored,
    setScenarioId,
    setNotes,
    updateNote,
    addNote,
    removeNote,
    updateHour,
    updateBattery,
    reset,
    toRequest,
  };
}
