import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IngestionModule } from './ingestion/ingestion.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),
    IngestionModule,
  ],
})
export class AppModule {}
