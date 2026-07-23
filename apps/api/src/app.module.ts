import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ExchangeModule } from './exchange/exchange.module';
import { MarketDataModule } from './market-data/market-data.module';
import { AIEngineModule } from './ai-engine/ai-engine.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Loads root .env when running from apps/api/ (local dev only)
      envFilePath: ['../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),
    ThrottlerModule.forRoot([{ name: 'global', ttl: 60_000, limit: 100 }]),
    PrismaModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: +config.get<string>('JWT_ACCESS_TTL', '900') },
      }),
    }),
    AuthModule,
    UsersModule,
    ExchangeModule,
    MarketDataModule,
    AIEngineModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
