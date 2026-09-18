"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, optimizeEnergy } from "@/lib/api";
import type { OptimizeRequest, OptimizeResponse } from "@/lib/types";

export type OptimizeStatus = "idle" | "loading" | "success" | "error";

interface OptimizeState {
  status: OptimizeStatus;
  data: OptimizeResponse | null;
  error: ApiError | null;
  /** Wall-clock time of the last completed run, for the results caption. */
  durationMs: number | null;
}

const INITIAL: OptimizeState = {
  status: "idle",
  data: null,
  error: null,
  durationMs: null,
};

/**
 * Runs an optimization request and exposes it as a small state machine.
 *
 * A second run supersedes the first: the in-flight request is aborted so a
 * slow earlier response can never overwrite a newer schedule.
 */
export function useOptimize() {
  const [state, setState] = useState<OptimizeState>(INITIAL);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  const run = useCallback(async (payload: OptimizeRequest) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setState((previous) => ({
      // Keep the previous schedule on screen while the next one is computed —
      // a dashboard that blanks out on every run is hard to compare against.
      ...previous,
      status: "loading",
      error: null,
    }));

    const startedAt = performance.now();

    try {
      const data = await optimizeEnergy(payload, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return null;

      setState({
        status: "success",
        data,
        error: null,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return data;
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return null;

      setState((previous) => ({
        ...previous,
        status: "error",
        error:
          error instanceof ApiError
            ? error
            : new ApiError(
                error instanceof Error ? error.message : "Unexpected failure.",
                null,
                [],
                "network",
              ),
      }));
      return null;
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    inFlight.current?.abort();
    setState(INITIAL);
  }, []);

  return {
    ...state,
    isLoading: state.status === "loading",
    run,
    reset,
  };
}
