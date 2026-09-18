import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { LlmService } from '../llm/llm.service.js';
import { OptimizerClient } from '../optimizer/optimizer.client.js';

@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly optimizer: OptimizerClient,
    private readonly llm: LlmService,
  ) {}

  /** Liveness probe consumed by the judge and by the Docker HEALTHCHECK. */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness detail for operators. Never fails: a missing dependency is
   * reported in the body, because `/health` must stay a pure liveness signal.
   */
  @Get('health/details')
  @HttpCode(HttpStatus.OK)
  async details() {
    return {
      status: 'ok',
      service: 'gridwise-api',
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      llm_configured: this.llm.isConfigured,
      optimizer_reachable: await this.optimizer.isReachable(),
      timestamp: new Date().toISOString(),
    };
  }
}
