import { Module } from '@nestjs/common';
import { BinanceTestnetClient } from '@quant/exchange';
import { EncryptionService } from '../common/encryption/encryption.service';
import { ExchangeService, BINANCE_CLIENT } from './exchange.service';
import { ExchangeController } from './exchange.controller';

@Module({
  providers: [
    EncryptionService,
    ExchangeService,
    { provide: BINANCE_CLIENT, useClass: BinanceTestnetClient },
  ],
  controllers: [ExchangeController],
  exports: [EncryptionService],
})
export class ExchangeModule {}
