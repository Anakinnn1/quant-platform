import { IsString, MinLength, MaxLength } from 'class-validator';

export class CreateExchangeKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @IsString()
  @MinLength(10)
  apiKey!: string;

  @IsString()
  @MinLength(10)
  apiSecret!: string;
}
