import { IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, MinLength } from 'class-validator';

export class UpdateRiskProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxPositionSizeUsd?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxDailyLossUsd?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxDrawdownPct?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOpenTrades?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cooldownMinutesAfterLoss?: number;
}
