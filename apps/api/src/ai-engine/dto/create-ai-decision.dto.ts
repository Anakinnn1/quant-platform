import { IsUUID } from 'class-validator';

export class CreateAIDecisionDto {
  @IsUUID()
  strategyId!: string;

  @IsUUID()
  symbolId!: string;
}
