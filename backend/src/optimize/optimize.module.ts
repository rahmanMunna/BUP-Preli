import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { OptimizerModule } from '../optimizer/optimizer.module.js';
import { ValidatorModule } from '../validator/validator.module.js';
import { OptimizeController } from './optimize.controller.js';
import { OptimizeService } from './optimize.service.js';

@Module({
  imports: [LlmModule, ValidatorModule, OptimizerModule],
  controllers: [OptimizeController],
  providers: [OptimizeService],
})
export class OptimizeModule {}
