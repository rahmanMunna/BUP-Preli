import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './filters/all-exceptions.filter.js';
import { LoggingInterceptor } from './interceptors/logging.interceptor.js';

/**
 * Global HTTP behaviour shared by `main.ts` and the e2e suite, so tests
 * exercise exactly the pipeline the judge hits.
 */
export function applyGlobalSetup(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // Unknown extra fields are dropped rather than rejected: a judge payload
      // carrying additional metadata must not fail the request.
      forbidNonWhitelisted: false,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableCors({ origin: '*' });

  return app;
}
