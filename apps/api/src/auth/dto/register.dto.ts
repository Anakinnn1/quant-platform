import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string = '';

  @IsString()
  @MinLength(8)
  @MaxLength(72) // argon2 input limit
  password: string = '';
}
