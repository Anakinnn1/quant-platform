import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicAIProvider, MockAIProvider } from '@quant/ai-engine';
import { AI_PROVIDER, AIDecisionsService } from './ai-decisions.service';
import { AIDecisionsController } from './ai-decisions.controller';

@Module({
  providers: [
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        return apiKey ? new AnthropicAIProvider(apiKey) : new MockAIProvider();
      },
    },
    AIDecisionsService,
  ],
  controllers: [AIDecisionsController],
  exports: [AI_PROVIDER, AIDecisionsService],
})
export class AIEngineModule {}
