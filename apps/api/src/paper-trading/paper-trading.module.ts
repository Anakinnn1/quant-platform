import { Module } from '@nestjs/common';
import { PaperTradingService } from './paper-trading.service';
import { TradesController } from './trades.controller';

@Module({
  providers: [PaperTradingService],
  controllers: [TradesController],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
