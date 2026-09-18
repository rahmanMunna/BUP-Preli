"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { checkHealth, type HealthDetails } from "@/lib/api";

export type HealthStatus = "checking" | "online" | "offline";

/**
 * Polls the API's health endpoint so the header can say whether the backend is
 * reachable before anyone presses Optimize and waits 20 seconds for a network
 * error. Failures here are expected and never surfaced as errors.
 */
export function useApiHealth(intervalMs = 30_000) {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [details, setDetails] = useState<HealthDetails | null>(null);
  const mounted = useRef(true);

  const probe = useCallback(async () => {
    try {
      const result = await checkHealth();
      if (!mounted.current) return;
      setDetails(result);
      setStatus("online");
    } catch {
      if (!mounted.current) return;
      setDetails(null);
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void probe();
    const timer = setInterval(() => void probe(), intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [probe, intervalMs]);

  return { status, details, refresh: probe };
}
