import { Module } from '@nestjs/common';
import { RiskProfilesService } from './risk-profiles.service';
import { RiskProfilesController } from './risk-profiles.controller';

@Module({
  providers: [RiskProfilesService],
  controllers: [RiskProfilesController],
  exports: [RiskProfilesService],
})
export class RiskModule {}
