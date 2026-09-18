import axios from 'axios';

/** Network blips, timeouts, rate limits and 5xx are worth another attempt. */
export function isRetryableHttpError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return true;
  const status = error.response?.status;
  if (status === undefined) return true; // timeout / DNS / connection reset
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/** Compact, log-safe description of an axios failure. */
export function describeHttpError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const status = error.response?.status;
  const body = error.response?.data;
  const detail =
    body === undefined
      ? ''
      : ` body=${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`;
  return `${error.code ?? 'HTTP_ERROR'}${status ? ` status=${status}` : ''} ${error.message}${detail}`;
}
