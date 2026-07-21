import { INestApplication, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import helmet from 'helmet';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { requestIdMiddleware } from '../src/common/middleware/request-id.middleware';

// Decode JWT payload without verifying signature (for assertions only)
function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
}

describe('Auth + Users (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<typeof app.getHttpServer>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: async () => ({ totalHits: 1, timeToExpire: 60_000, isBlocked: false, timeToBlockExpire: 0 }),
      })
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
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function register(email = 'alice@test.com', password = 'password123') {
    return request(server).post('/api/v1/auth/register').send({ email, password });
  }

  async function login(email = 'alice@test.com', password = 'password123') {
    return request(server).post('/api/v1/auth/login').send({ email, password });
  }

  // ── POST /auth/register ────────────────────────────────────────────────────

  describe('POST /api/v1/auth/register', () => {
    it('201 + tokens on valid input', async () => {
      const res = await register();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
    });

    it('JWT payload has correct role and sub', async () => {
      const res = await register();
      const payload = decodeJwt(res.body.accessToken as string);
      expect(payload.role).toBe('USER');
      expect(typeof payload.sub).toBe('string');
      expect(payload.email).toBe('alice@test.com');
    });

    it('409 on duplicate email', async () => {
      await register();
      const res = await register();
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('CONFLICT');
    });

    it('422 on invalid email', async () => {
      const res = await request(server)
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'password123' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('422 on short password', async () => {
      const res = await request(server)
        .post('/api/v1/auth/register')
        .send({ email: 'alice@test.com', password: 'short' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('error body matches §10 shape', async () => {
      await register();
      const res = await register(); // duplicate
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: expect.any(String),
        message: expect.any(String),
        path: expect.any(String),
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });

  // ── POST /auth/login ───────────────────────────────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    beforeEach(() => register());

    it('200 + tokens on valid credentials', async () => {
      const res = await login();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
    });

    it('401 on wrong password', async () => {
      const res = await login('alice@test.com', 'wrongpassword');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('401 on unknown email', async () => {
      const res = await login('nobody@test.com');
      expect(res.status).toBe(401);
    });
  });

  // ── GET /users/me ──────────────────────────────────────────────────────────

  describe('GET /api/v1/users/me', () => {
    it('200 + user object with valid token', async () => {
      const reg = await register();
      const res = await request(server)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${reg.body.accessToken as string}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        email: 'alice@test.com',
        role: 'USER',
      });
      expect(res.body.passwordHash).toBeUndefined();
    });

    it('401 without token', async () => {
      const res = await request(server).get('/api/v1/users/me');
      expect(res.status).toBe(401);
    });

    it('401 with malformed token', async () => {
      const res = await request(server)
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer garbage');
      expect(res.status).toBe(401);
    });
  });

  // ── PATCH /users/me ────────────────────────────────────────────────────────

  describe('PATCH /api/v1/users/me', () => {
    it('200 on valid email update', async () => {
      const reg = await register();
      const res = await request(server)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
        .send({ email: 'alice-new@test.com' });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('alice-new@test.com');
    });

    it('401 without token', async () => {
      const res = await request(server).patch('/api/v1/users/me').send({ email: 'x@test.com' });
      expect(res.status).toBe(401);
    });
  });

  // ── POST /auth/refresh ─────────────────────────────────────────────────────

  describe('POST /api/v1/auth/refresh', () => {
    it('200 + new token pair on valid refresh token', async () => {
      const reg = await register();
      const res = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: reg.body.refreshToken as string });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      // New tokens must differ from original
      expect(res.body.accessToken).not.toBe(reg.body.accessToken);
      expect(res.body.refreshToken).not.toBe(reg.body.refreshToken);
    });

    it('401 after token is rotated (old token rejected)', async () => {
      const reg = await register();
      const original = reg.body.refreshToken as string;
      // Use the token once to rotate it
      await request(server).post('/api/v1/auth/refresh').send({ refreshToken: original });
      // Reuse original → must fail
      const res = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original });
      expect(res.status).toBe(401);
    });

    it('401 on garbage token', async () => {
      const res = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'not.valid' });
      expect(res.status).toBe(401);
    });
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────────

  describe('POST /api/v1/auth/logout', () => {
    it('200 and refresh token is subsequently revoked', async () => {
      const reg = await register();
      const { accessToken, refreshToken } = reg.body as {
        accessToken: string;
        refreshToken: string;
      };

      const logout = await request(server)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(logout.status).toBe(200);

      // Refresh with revoked token must fail
      const refreshRes = await request(server).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it('401 without access token', async () => {
      const reg = await register();
      const res = await request(server)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: reg.body.refreshToken as string });
      expect(res.status).toBe(401);
    });
  });

  // ── RBAC wiring ────────────────────────────────────────────────────────────

  describe('RBAC — role in JWT', () => {
    it('newly registered user has role USER', async () => {
      const reg = await register();
      const payload = decodeJwt(reg.body.accessToken as string);
      expect(payload.role).toBe('USER');
    });

    it('token role updates after DB role is elevated to ADMIN', async () => {
      const reg = await register();
      const payload = decodeJwt(reg.body.accessToken as string);
      // Promote to ADMIN directly in DB (simulates an admin action)
      await prisma.user.update({
        where: { id: payload.sub as string },
        data: { role: 'ADMIN' },
      });
      // Re-login to get a fresh token reflecting the new role
      const loginRes = await login();
      const newPayload = decodeJwt(loginRes.body.accessToken as string);
      expect(newPayload.role).toBe('ADMIN');
    });
  });
});
