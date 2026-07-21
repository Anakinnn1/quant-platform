import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { BinanceTestnetClient } from '@quant/exchange';
import { PrismaService } from '../common/prisma/prisma.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import type { CreateExchangeKeyDto } from './dto/create-exchange-key.dto';

export const BINANCE_CLIENT = 'BINANCE_CLIENT';

const KEY_SELECT = {
  id: true,
  label: true,
  isTestnet: true,
  keyVersion: true,
  createdAt: true,
} as const;

@Injectable()
export class ExchangeService {
  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    @Inject(BINANCE_CLIENT) private binance: BinanceTestnetClient,
  ) {}

  async createKey(userId: string, dto: CreateExchangeKeyDto) {
    // Validate key against Binance Testnet before storing.
    await this.binance.getAccountBalance(dto.apiKey, dto.apiSecret);

    return this.prisma.exchangeKey.create({
      data: {
        userId,
        label: dto.label,
        apiKeyEnc: this.encryption.encrypt(dto.apiKey),
        apiSecretEnc: this.encryption.encrypt(dto.apiSecret),
        isTestnet: true,
        keyVersion: 1,
      },
      select: KEY_SELECT,
    });
  }

  async listKeys(userId: string) {
    return this.prisma.exchangeKey.findMany({
      where: { userId },
      select: KEY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBalance(userId: string, keyId: string) {
    const key = await this.prisma.exchangeKey.findUniqueOrThrow({ where: { id: keyId } });
    if (key.userId !== userId) throw new ForbiddenException();
    return this.binance.getAccountBalance(
      this.encryption.decrypt(key.apiKeyEnc),
      this.encryption.decrypt(key.apiSecretEnc),
    );
  }

  async deleteKey(userId: string, keyId: string) {
    const key = await this.prisma.exchangeKey.findUniqueOrThrow({ where: { id: keyId } });
    if (key.userId !== userId) throw new ForbiddenException();
    await this.prisma.exchangeKey.delete({ where: { id: keyId } });
  }
}
