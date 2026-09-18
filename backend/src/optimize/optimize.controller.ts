import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { OptimizeEnergyRequestDto } from '../schemas/optimize-request.dto.js';
import type { OptimizeEnergyResponse } from '../schemas/optimize-response.dto.js';
import { OptimizeService } from './optimize.service.js';

@Controller()
export class OptimizeController {
  constructor(private readonly optimizeService: OptimizeService) {}

  /**
   * Public entry point for the judge.
   *
   * The body is validated by the global `ValidationPipe`; a malformed payload
   * fails here with 400 before a single token is spent on the LLM.
   */
  @Post('optimize-energy')
  @HttpCode(HttpStatus.OK)
  async optimizeEnergy(
    @Body() request: OptimizeEnergyRequestDto,
  ): Promise<OptimizeEnergyResponse> {
    return this.optimizeService.optimizeEnergy(request);
  }
}
