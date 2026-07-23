import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { AIDecisionsService } from './ai-decisions.service';
import { CreateAIDecisionDto } from './dto/create-ai-decision.dto';

@Controller('ai-decisions')
@UseGuards(JwtAuthGuard)
export class AIDecisionsController {
  constructor(private readonly service: AIDecisionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  requestSignal(@CurrentUser() user: JwtPayload, @Body() dto: CreateAIDecisionDto) {
    return this.service.requestSignal(user.sub, dto.strategyId, dto.symbolId);
  }

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('strategyId') strategyId?: string) {
    return this.service.list(user.sub, strategyId);
  }

  @Get(':id')
  getById(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.service.getById(user.sub, id);
  }
}
