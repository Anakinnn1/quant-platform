import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' });
  app.use(helmet({ contentSecurityPolicy: false })); // CSP off — SSE connect-src needs flexibility in dev
  app.use(requestIdMiddleware);
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Map validation errors to 422 per §10
      exceptionFactory: (errors) => {
        const message = errors.flatMap((e) => Object.values(e.constraints ?? {})).join('; ');
        return new UnprocessableEntityException(message);
      },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
}

bootstrap();
