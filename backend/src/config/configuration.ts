function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export type LlmProviderName = 'gemini' | 'openrouter';

export interface AppConfig {
  port: number;
  llm: {
    geminiApiKey: string;
    geminiModel: string;
    geminiBaseUrl: string;
    openRouterApiKey: string;
    openRouterModel: string;
    openRouterBaseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    temperature: number;
    maxOutputTokens: number;
    /** Which provider is tried first; unknown or unkeyed entries are skipped. */
    providerOrder: LlmProviderName[];
  };
  optimizer: {
    url: string;
    path: string;
    timeoutMs: number;
    maxRetries: number;
    fallbackEnabled: boolean;
  };
}

function providerOrder(value: string | undefined): LlmProviderName[] {
  const parsed = (value ?? 'gemini,openrouter')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is LlmProviderName =>
      ['gemini', 'openrouter'].includes(name),
    );
  return parsed.length ? [...new Set(parsed)] : ['gemini', 'openrouter'];
}

export const configuration = (): AppConfig => ({
  port: int(process.env.PORT, 3000),
  llm: {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    geminiBaseUrl:
      process.env.GEMINI_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta',
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    openRouterModel: process.env.OPENROUTER_MODEL ?? 'google/gemini-3.6-flash',
    openRouterBaseUrl:
      process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 30_000),
    maxRetries: int(process.env.LLM_MAX_RETRIES, 2),
    temperature: Number.parseFloat(process.env.LLM_TEMPERATURE ?? '0') || 0,
    maxOutputTokens: int(process.env.LLM_MAX_OUTPUT_TOKENS, 4096),
    providerOrder: providerOrder(process.env.LLM_PROVIDER_ORDER),
  },
  optimizer: {
    url: process.env.OPTIMIZER_URL ?? 'http://localhost:8000',
    path: process.env.OPTIMIZER_PATH ?? '/solve',
    timeoutMs: int(process.env.OPTIMIZER_TIMEOUT_MS, 20_000),
    maxRetries: int(process.env.OPTIMIZER_MAX_RETRIES, 2),
    fallbackEnabled: bool(process.env.OPTIMIZER_FALLBACK_ENABLED, true),
  },
});
