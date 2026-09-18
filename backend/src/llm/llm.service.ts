import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  describeHttpError,
  isRetryableHttpError,
} from '../common/utils/http-error.js';
import { describe, withRetry } from '../common/utils/retry.js';
import type { AppConfig, LlmProviderName } from '../config/configuration.js';
import { JsonRepairError, parseJsonLoose } from './json-repair.js';
import {
  buildRepairPrompt,
  buildUserPrompt,
  SYSTEM_PROMPT,
  type NoteForInterpretation,
} from './prompt.js';

export type LlmProvider = 'gemini' | 'openrouter' | 'none';

/** Raised when a provider answered, but not in a usable shape. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

/** Model output before validation — every field is still untrusted. */
export interface RawInterpretation {
  note_index?: unknown;
  applies?: unknown;
  directive_type?: unknown;
  structured_adjustment?: unknown;
  explanation?: unknown;
}

export interface LlmInterpretationResult {
  interpretations: RawInterpretation[];
  provider: LlmProvider;
  /** True when no provider answered and the caller must degrade to no_op. */
  degraded: boolean;
  latency_ms: number;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly config: AppConfig['llm'];
  private readonly http: AxiosInstance;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.config = configService.get('llm', { infer: true });
    this.http = axios.create({
      timeout: this.config.timeoutMs,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  get isConfigured(): boolean {
    return Boolean(this.config.geminiApiKey || this.config.openRouterApiKey);
  }

  /**
   * Turns operator notes into candidate directives. Tries Gemini first, then
   * OpenRouter; if both are unusable the caller receives `degraded: true` and
   * is expected to fall back to no_op rather than to guess.
   */
  async interpret(
    notes: NoteForInterpretation[],
    horizonHours: number[],
    problems: string[] = [],
  ): Promise<LlmInterpretationResult> {
    const startedAt = Date.now();

    if (notes.length === 0) {
      return {
        interpretations: [],
        provider: 'none',
        degraded: false,
        latency_ms: 0,
      };
    }

    const userPrompt = problems.length
      ? buildRepairPrompt(notes, horizonHours, problems)
      : buildUserPrompt(notes, horizonHours);

    // `LLM_PROVIDER_ORDER` decides who is tried first: Gemini's free tier can
    // sit under load on the day, and swapping the order is then a config change
    // rather than a deploy.
    const runners: Record<LlmProviderName, () => Promise<string>> = {
      gemini: () => this.callGemini(userPrompt),
      openrouter: () => this.callOpenRouter(userPrompt),
    };
    const keys: Record<LlmProviderName, string> = {
      gemini: this.config.geminiApiKey,
      openrouter: this.config.openRouterApiKey,
    };

    const providers = this.config.providerOrder
      .filter((name) => Boolean(keys[name]))
      .map((name) => ({ name, run: runners[name] }));

    if (providers.length === 0) {
      this.logger.error(
        'No LLM credentials configured (GEMINI_API_KEY / OPENROUTER_API_KEY) — every note will degrade to no_op',
      );
      return {
        interpretations: [],
        provider: 'none',
        degraded: true,
        latency_ms: Date.now() - startedAt,
      };
    }

    for (const provider of providers) {
      try {
        const interpretations = await withRetry(
          async () => this.extractInterpretations(await provider.run()),
          {
            retries: this.config.maxRetries,
            label: `llm:${provider.name}`,
            logger: this.logger,
            shouldRetry: (error) =>
              error instanceof JsonRepairError ||
              error instanceof ShapeError ||
              isRetryableHttpError(error),
          },
        );

        this.logger.log(
          `Interpreted ${notes.length} note(s) via ${provider.name} in ${Date.now() - startedAt}ms`,
        );
        return {
          interpretations,
          provider: provider.name,
          degraded: false,
          latency_ms: Date.now() - startedAt,
        };
      } catch (error) {
        this.logger.error(
          `Provider ${provider.name} exhausted: ${describeHttpError(error)}`,
        );
      }
    }

    this.logger.error(
      'All LLM providers failed — degrading to no_op directives',
    );
    return {
      interpretations: [],
      provider: 'none',
      degraded: true,
      latency_ms: Date.now() - startedAt,
    };
  }

  /** Google Gemini generateContent, pinned to JSON output mode. */
  private async callGemini(userPrompt: string): Promise<string> {
    const {
      geminiBaseUrl,
      geminiModel,
      geminiApiKey,
      temperature,
      maxOutputTokens,
    } = this.config;
    const url = `${geminiBaseUrl}/models/${geminiModel}:generateContent`;

    const { data } = await this.http.post(
      url,
      {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          maxOutputTokens,
        },
      },
      { headers: { 'x-goog-api-key': geminiApiKey } },
    );

    const parts = data?.candidates?.[0]?.content?.parts;
    const text: string = Array.isArray(parts)
      ? parts.map((part: { text?: string }) => part?.text ?? '').join('')
      : '';

    if (!text.trim()) {
      const reason = data?.candidates?.[0]?.finishReason ?? 'unknown';
      throw new ShapeError(`Gemini returned no text (finishReason=${reason})`);
    }
    return text;
  }

  /** OpenRouter chat completions — used when Gemini is unavailable. */
  private async callOpenRouter(userPrompt: string): Promise<string> {
    const {
      openRouterBaseUrl,
      openRouterModel,
      openRouterApiKey,
      temperature,
      maxOutputTokens,
    } = this.config;

    const { data } = await this.http.post(
      `${openRouterBaseUrl}/chat/completions`,
      {
        model: openRouterModel,
        temperature,
        // Without an explicit cap OpenRouter reserves the model's full context
        // window and rejects the call (402) whenever the account cannot afford
        // that reservation — the interpretation itself needs a few hundred.
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${openRouterApiKey}`,
          'HTTP-Referer': 'https://bupcsefest.gridwise.local',
          'X-Title': 'GridWise Campus Energy API',
        },
      },
    );

    const text: string = data?.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new ShapeError('OpenRouter returned no content');
    return text;
  }

  /** Accepts the documented envelope plus the shapes models commonly drift to. */
  private extractInterpretations(text: string): RawInterpretation[] {
    const parsed = parseJsonLoose<unknown>(text);

    const candidate = Array.isArray(parsed)
      ? parsed
      : this.pickArray(parsed as Record<string, unknown>);

    if (!Array.isArray(candidate)) {
      throw new ShapeError(
        `Expected an array of interpretations, received ${describe(parsed).slice(0, 200)}`,
      );
    }

    return candidate.filter(
      (item): item is RawInterpretation =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
    );
  }

  private pickArray(parsed: Record<string, unknown> | null): unknown {
    if (!parsed || typeof parsed !== 'object') return undefined;
    for (const key of [
      'interpretations',
      'directive_interpretation',
      'directives',
      'results',
      'notes',
    ]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // A single interpretation object returned bare.
    if ('note_index' in parsed || 'directive_type' in parsed) return [parsed];
    return undefined;
  }
}
