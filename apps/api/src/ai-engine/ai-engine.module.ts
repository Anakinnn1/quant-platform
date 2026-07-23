import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicAIProvider, GroqAIProvider, MockAIProvider } from '@quant/ai-engine';
import { AI_PROVIDER, AIDecisionsService } from './ai-decisions.service';
import { AIDecisionsController } from './ai-decisions.controller';

@Module({
  providers: [
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const groqKey = config.get<string>('GROQ_API_KEY');
        if (groqKey) return new GroqAIProvider(groqKey);
        const anthropicKey = config.get<string>('ANTHROPIC_API_KEY');
        if (anthropicKey) return new AnthropicAIProvider(anthropicKey);
        return new MockAIProvider();
      },
    },
    AIDecisionsService,
  ],
  controllers: [AIDecisionsController],
  exports: [AI_PROVIDER, AIDecisionsService],
})
export class AIEngineModule {}
