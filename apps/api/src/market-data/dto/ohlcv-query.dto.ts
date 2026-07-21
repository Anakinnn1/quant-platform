import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class OhlcvQueryDto {
  @IsString()
  symbol!: string;

  @IsIn(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
  interval!: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Cursor = ISO timestamp of the last openTime returned. */
  @IsOptional()
  @IsDateString()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  limit?: number;
}
