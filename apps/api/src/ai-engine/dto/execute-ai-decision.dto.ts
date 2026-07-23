import { IsNumber, IsOptional, IsPositive } from 'class-validator';

export class ExecuteAIDecisionDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  positionSizeUsd?: number;
}
