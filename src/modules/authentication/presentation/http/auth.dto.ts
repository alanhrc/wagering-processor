import { ApiProperty } from '@nestjs/swagger';

export class AuthCredentialsDto {
  @ApiProperty({ example: 'alan@example.com', description: 'Account email address.' })
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery-staple', minLength: 12, description: 'Password with at least 12 characters.' })
  password!: string;
}

export class AuthenticatedUserDto {
  @ApiProperty({ example: '4e41b9b0-8127-4f17-8ba5-8f405e358e25' })
  id!: string;

  @ApiProperty({ example: 'alan@example.com' })
  email!: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({ example: 900 })
  expiresIn!: number;
}
