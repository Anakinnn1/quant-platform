import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';

const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    let user;
    try {
      user = await this.prisma.user.create({
        data: { email: dto.email, passwordHash },
        select: { id: true, email: true, role: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      throw e;
    }
    return this.issueTokens(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true, role: true, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.issueTokens(user.id, user.email, user.role);
  }

  async refresh(rawToken: string) {
    const dotIdx = rawToken.indexOf('.');
    if (dotIdx === -1) throw new UnauthorizedException('Invalid refresh token');
    const tokenId = rawToken.slice(0, dotIdx);
    const rawSecret = rawToken.slice(dotIdx + 1);

    const stored = await this.prisma.refreshToken.findUnique({ where: { id: tokenId } });
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired or revoked');
    }

    const valid = await argon2.verify(stored.tokenHash, rawSecret);
    if (!valid) throw new UnauthorizedException('Invalid refresh token');

    // Rotate: revoke old token before issuing new one
    await this.prisma.refreshToken.update({ where: { id: tokenId }, data: { revoked: true } });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: stored.userId },
      select: { id: true, email: true, role: true },
    });
    return this.issueTokens(user.id, user.email, user.role);
  }

  async logout(rawToken: string) {
    const tokenId = rawToken.split('.')[0];
    if (!tokenId) return;
    // updateMany silently ignores not-found rather than throwing
    await this.prisma.refreshToken.updateMany({
      where: { id: tokenId, revoked: false },
      data: { revoked: true },
    });
  }

  private async issueTokens(userId: string, email: string, role: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email, role, jti: randomUUID() });

    const rawSecret = randomBytes(32).toString('hex');
    const tokenId = randomUUID();
    const tokenHash = await argon2.hash(rawSecret, ARGON2_OPTIONS);
    const refreshTtlMs = +this.config.get<string>('JWT_REFRESH_TTL', '604800') * 1000;
    const expiresAt = new Date(Date.now() + refreshTtlMs);

    await this.prisma.refreshToken.create({
      data: { id: tokenId, userId, tokenHash, expiresAt },
    });

    return { accessToken, refreshToken: `${tokenId}.${rawSecret}` };
  }
}
