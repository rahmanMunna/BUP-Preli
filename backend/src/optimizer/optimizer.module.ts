import { Module } from '@nestjs/common';
import { LocalOptimizer } from './local-optimizer.js';
import { OptimizerClient } from './optimizer.client.js';

@Module({
  providers: [LocalOptimizer, OptimizerClient],
  exports: [OptimizerClient],
})
export class OptimizerModule {}
