import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // Headless NestJS — no HTTP listener, just the DI container + services.
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();
}

bootstrap().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
