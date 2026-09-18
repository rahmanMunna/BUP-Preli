/**
 * Typed client for the GridWise NestJS API.
 *
 * Everything the dashboard knows about the backend lives here: the base URL,
 * the timeout, and how an error becomes something the UI can display.
 */

import type { ApiErrorBody, OptimizeRequest, OptimizeResponse } from "./types";

/** Configured at build time; see `.env.local.example`. */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

/**
 * Generous by design: the request fans out to an LLM and then to the Python
 * optimizer, and a cold Gemini call alone can take 20s.
 */
export const REQUEST_TIMEOUT_MS = Number(
  process.env.NEXT_PUBLIC_API_TIMEOUT_MS ?? 90_000,
);

/** An API failure with everything the UI needs to explain it to a human. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly details: string[] = [],
    readonly kind: "network" | "timeout" | "http" | "parse" = "http",
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Whether trying the exact same request again could plausibly work. */
  get isRetryable(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    return this.status !== null && this.status >= 500;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Let a caller-supplied signal (component unmount) also cancel the request.
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...rest.headers },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(
        `The API did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        null,
        ["The optimizer may still be working. Try again in a moment."],
        "timeout",
      );
    }
    throw new ApiError(
      `Could not reach the API at ${API_BASE_URL}.`,
      null,
      [
        "Check that the NestJS service is running.",
        `Set NEXT_PUBLIC_API_BASE_URL if it listens somewhere other than ${API_BASE_URL}.`,
        error instanceof Error ? error.message : String(error),
      ],
      "network",
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  if (!response.ok) {
    throw toApiError(response.status, raw);
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(
      "The API returned a response that is not valid JSON.",
      response.status,
      [raw.slice(0, 200)],
      "parse",
    );
  }
}

/** Turns the NestJS error envelope into a single message plus detail lines. */
function toApiError(status: number, raw: string): ApiError {
  let body: ApiErrorBody | undefined;
  try {
    body = JSON.parse(raw) as ApiErrorBody;
  } catch {
    // Not JSON — fall through to the generic message below.
  }

  if (!body) {
    return new ApiError(
      `The API responded with ${status}.`,
      status,
      raw ? [raw.slice(0, 200)] : [],
    );
  }

  const messages = Array.isArray(body.message)
    ? body.message
    : [body.message].filter(Boolean);

  const headline =
    status === 400
      ? "The scenario was rejected by the API."
      : status === 503
        ? "The optimizer service is unavailable."
        : `The API responded with ${status} ${body.error ?? ""}`.trim();

  return new ApiError(headline, status, messages);
}

export function optimizeEnergy(
  payload: OptimizeRequest,
  options: { signal?: AbortSignal } = {},
): Promise<OptimizeResponse> {
  return request<OptimizeResponse>("/optimize-energy", {
    method: "POST",
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

export interface HealthDetails {
  status: string;
  service?: string;
  uptime_seconds?: number;
  llm_configured?: boolean;
  optimizer_reachable?: boolean;
}

/** Short timeout: this drives a status chip, it must never block the UI. */
export function checkHealth(
  options: { signal?: AbortSignal } = {},
): Promise<HealthDetails> {
  return request<HealthDetails>("/health/details", {
    method: "GET",
    timeoutMs: 5_000,
    signal: options.signal,
  });
}
