import { Logger } from '@nestjs/common';

export interface RetryOptions {
  /** Number of retries AFTER the initial attempt. */
  retries: number;
  /** Base backoff in ms; doubled per attempt and jittered. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  label: string;
  logger?: Logger;
  /** Return false to fail fast (e.g. HTTP 400 — retrying cannot help). */
  shouldRetry?: (error: unknown) => boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `task` with exponential backoff + full jitter. Jitter matters because
 * the judge may fire several scenarios at once and we do not want every
 * retry wave to hit Gemini in lockstep.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    retries,
    baseDelayMs = 300,
    maxDelayMs = 4_000,
    label,
    logger,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry(error);
      const exhausted = attempt >= retries;
      logger?.warn(
        `${label} attempt ${attempt + 1}/${retries + 1} failed: ${describe(error)}${
          retryable && !exhausted ? ' — retrying' : ' — giving up'
        }`,
      );
      if (!retryable || exhausted) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(Math.round(delay * (0.5 + Math.random() / 2)));
    }
  }

  throw lastError;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
