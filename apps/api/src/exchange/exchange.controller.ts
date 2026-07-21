import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { ExchangeService } from './exchange.service';
import { CreateExchangeKeyDto } from './dto/create-exchange-key.dto';

@Controller('users/me/exchange-keys')
@UseGuards(JwtAuthGuard)
export class ExchangeController {
  constructor(private exchange: ExchangeService) {}

  @Post()
  createKey(@CurrentUser() user: JwtPayload, @Body() dto: CreateExchangeKeyDto) {
    return this.exchange.createKey(user.sub, dto);
  }

  @Get()
  listKeys(@CurrentUser() user: JwtPayload) {
    return this.exchange.listKeys(user.sub);
  }

  @Get(':id/balance')
  getBalance(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.exchange.getBalance(user.sub, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteKey(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.exchange.deleteKey(user.sub, id);
  }
}
