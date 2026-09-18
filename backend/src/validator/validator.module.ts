import { Module } from '@nestjs/common';
import { DirectiveValidatorService } from './directive.validator.js';

@Module({
  providers: [DirectiveValidatorService],
  exports: [DirectiveValidatorService],
})
export class ValidatorModule {}
