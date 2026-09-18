import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NormalizeBodyMiddleware } from './common/middleware/normalize-body.middleware.js';
import { configuration } from './config/configuration.js';
import { HealthModule } from './health/health.module.js';
import { OptimizeModule } from './optimize/optimize.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
    }),
    HealthModule,
    OptimizeModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(NormalizeBodyMiddleware).forRoutes('optimize-energy');
  }
}
