import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { OptimizerModule } from '../optimizer/optimizer.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [OptimizerModule, LlmModule],
  controllers: [HealthController],
})
export class HealthModule {}
