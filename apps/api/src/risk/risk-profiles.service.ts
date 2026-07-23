import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateRiskProfileDto } from './dto/create-risk-profile.dto';
import type { UpdateRiskProfileDto } from './dto/update-risk-profile.dto';

@Injectable()
export class RiskProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateRiskProfileDto) {
    return this.prisma.riskProfile.create({ data: dto });
  }

  list() {
    return this.prisma.riskProfile.findMany({ orderBy: { name: 'asc' } });
  }

  async update(id: string, dto: UpdateRiskProfileDto) {
    await this.prisma.riskProfile.findUniqueOrThrow({ where: { id } }).catch(() => {
      throw new NotFoundException(`RiskProfile ${id} not found`);
    });
    return this.prisma.riskProfile.update({ where: { id }, data: dto });
  }
}
