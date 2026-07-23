import { IsInt, IsNumber, IsPositive, IsString, Min, MinLength } from 'class-validator';

export class CreateRiskProfileDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsNumber()
  @IsPositive()
  maxPositionSizeUsd!: number;

  @IsNumber()
  @IsPositive()
  maxDailyLossUsd!: number;

  @IsNumber()
  @IsPositive()
  maxDrawdownPct!: number;

  @IsInt()
  @Min(1)
  maxOpenTrades!: number;

  @IsInt()
  @Min(0)
  cooldownMinutesAfterLoss!: number;
}
