import type { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * Deletes all rows in FK-safe order. Call at the top of every beforeEach
 * so each test starts with a clean slate, regardless of suite ordering.
 */
export async function cleanDb(prisma: PrismaService): Promise<void> {
  await prisma.riskEvaluation.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.aIDecision.deleteMany();
  await prisma.backtest.deleteMany();
  await prisma.strategy.deleteMany();
  await prisma.riskProfile.deleteMany();
  await prisma.oHLCV.deleteMany();
  await prisma.symbol.deleteMany();
  await prisma.exchangeKey.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
}
