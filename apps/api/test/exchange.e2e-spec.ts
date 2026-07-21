import { INestApplication, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import helmet from 'helmet';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { requestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { EncryptionService } from '../src/common/encryption/encryption.service';
import { BINANCE_CLIENT } from '../src/exchange/exchange.service';

const mockBinance = {
  getAccountBalance: jest.fn().mockResolvedValue([
    { asset: 'BTC', free: '1.0', locked: '0' },
    { asset: 'USDT', free: '10000', locked: '0' },
  ]),
  getKlines: jest.fn().mockResolvedValue([]),
};

describe('Exchange Keys (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let encryption: EncryptionService;
  let server: ReturnType<typeof app.getHttpServer>;
  let accessToken: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({ increment: async () => ({ totalHits: 1, timeToExpire: 60_000, isBlocked: false, timeToBlockExpire: 0 }) })
      .overrideProvider(BINANCE_CLIENT)
      .useValue(mockBinance)
      .compile();

    app = module.createNestApplication();
    app.use(helmet());
    app.use(requestIdMiddleware);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) =>
          new UnprocessableEntityException(
            errors.flatMap((e) => Object.values(e.constraints ?? {})).join('; '),
          ),
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    encryption = app.get(EncryptionService);
    server = app.getHttpServer();
  });

  afterAll(() => app.close());

  beforeEach(async () => {
    await prisma.exchangeKey.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();

    const reg = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: 'trader@test.com', password: 'password123' });
    accessToken = reg.body.accessToken as string;
  });

  // ── Encryption service round-trip ──────────────────────────────────────────

  describe('EncryptionService', () => {
    it('encrypts to a different string than plaintext', () => {
      const plaintext = 'super-secret-api-key';
      expect(encryption.encrypt(plaintext)).not.toBe(plaintext);
    });

    it('round-trips correctly', () => {
      const plaintext = 'my-binance-testnet-api-key-12345';
      expect(encryption.decrypt(encryption.encrypt(plaintext))).toBe(plaintext);
    });

    it('produces a different ciphertext each time (random IV)', () => {
      const plaintext = 'same-input';
      expect(encryption.encrypt(plaintext)).not.toBe(encryption.encrypt(plaintext));
    });
  });

  // ── POST /users/me/exchange-keys ───────────────────────────────────────────

  describe('POST /api/v1/users/me/exchange-keys', () => {
    it('201 with masked response (no plaintext keys in body)', async () => {
      const res = await request(server)
        .post('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ label: 'My Testnet Key', apiKey: 'fake-api-key-12345', apiSecret: 'fake-api-secret-12345' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.label).toBe('My Testnet Key');
      expect(res.body.isTestnet).toBe(true);
      // Plaintext must NOT leak in the response
      expect(JSON.stringify(res.body)).not.toContain('fake-api-key');
      expect(JSON.stringify(res.body)).not.toContain('fake-api-secret');
    });

    it('stores encrypted values (not plaintext) in the database', async () => {
      const res = await request(server)
        .post('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ label: 'Key', apiKey: 'plaintext-api-key', apiSecret: 'plaintext-api-secret' });

      const stored = await prisma.exchangeKey.findUnique({ where: { id: res.body.id as string } });
      expect(stored!.apiKeyEnc).not.toBe('plaintext-api-key');
      expect(stored!.apiSecretEnc).not.toBe('plaintext-api-secret');

      // Round-trip decryption must recover the originals
      expect(encryption.decrypt(stored!.apiKeyEnc)).toBe('plaintext-api-key');
      expect(encryption.decrypt(stored!.apiSecretEnc)).toBe('plaintext-api-secret');
    });

    it('validates Binance Testnet before storing', async () => {
      expect(mockBinance.getAccountBalance).toHaveBeenCalled();
    });

    it('401 without token', async () => {
      const res = await request(server)
        .post('/api/v1/users/me/exchange-keys')
        .send({ label: 'k', apiKey: 'x', apiSecret: 'y' });
      expect(res.status).toBe(401);
    });

    it('422 on missing fields', async () => {
      const res = await request(server)
        .post('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ label: 'k' }); // missing apiKey + apiSecret
      expect(res.status).toBe(422);
    });
  });

  // ── GET /users/me/exchange-keys ────────────────────────────────────────────

  describe('GET /api/v1/users/me/exchange-keys', () => {
    it('returns list of keys without encrypted values', async () => {
      await request(server)
        .post('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ label: 'Key A', apiKey: 'key-a-12345', apiSecret: 'secret-a-12345' });

      const res = await request(server)
        .get('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].label).toBe('Key A');
      expect(res.body[0].apiKeyEnc).toBeUndefined();
    });
  });

  // ── DELETE /users/me/exchange-keys/:id ────────────────────────────────────

  describe('DELETE /api/v1/users/me/exchange-keys/:id', () => {
    it('204 on successful delete', async () => {
      const create = await request(server)
        .post('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ label: 'Temp', apiKey: 'temp-key-12345', apiSecret: 'temp-secret-12345' });

      const del = await request(server)
        .delete(`/api/v1/users/me/exchange-keys/${create.body.id as string}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(del.status).toBe(204);

      const list = await request(server)
        .get('/api/v1/users/me/exchange-keys')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(list.body).toHaveLength(0);
    });
  });
});
