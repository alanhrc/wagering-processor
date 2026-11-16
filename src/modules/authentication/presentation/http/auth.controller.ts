import { BadRequestException, Body, ConflictException, Controller, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthenticateUserUseCase, InvalidCredentialsError, InvalidRegistrationError, RegisterUserUseCase } from '../../application/authentication.use-cases.js';
import { AuthUserEmailAlreadyExistsError } from '../../domain/auth-user.js';
import { Public } from '../../../../shared/infrastructure/auth/access-token.guard.js';
import { AuthCredentialsDto, AuthenticatedUserDto } from './auth.dto.js';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string };
}

function isCredentials(body: unknown): body is AuthCredentialsDto {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const credentials = body as Record<string, unknown>;
  return typeof credentials.email === 'string' && typeof credentials.password === 'string';
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUserUseCase,
    private readonly authenticateUser: AuthenticateUserUseCase,
  ) {}

  @Post('register')
  @Public()
  @ApiOperation({ summary: 'Register a user', description: 'Creates an account using an Argon2id password hash and returns a short-lived access token.' })
  @ApiBody({ type: AuthCredentialsDto, examples: { registration: { value: { email: 'alan@example.com', password: 'correct-horse-battery-staple' } } } })
  @ApiCreatedResponse({ description: 'Account created.', type: AuthenticatedUserDto })
  @ApiBadRequestResponse({ description: 'Invalid email or password shorter than 12 characters.' })
  @ApiConflictResponse({ description: 'An account with this email already exists.' })
  async register(@Body() body: AuthCredentialsDto): Promise<AuthenticatedUserDto> {
    if (!isCredentials(body)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Email and password are required.' });
    try {
      return await this.registerUser.execute(body.email, body.password);
    } catch (error: unknown) {
      if (error instanceof InvalidRegistrationError) throw new BadRequestException({ code: 'INVALID_REGISTRATION', message: error.message });
      if (error instanceof AuthUserEmailAlreadyExistsError) throw new ConflictException({ code: 'EMAIL_ALREADY_REGISTERED', message: error.message });
      throw error;
    }
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in', description: 'Verifies the password hash and returns a short-lived JWT access token.' })
  @ApiBody({ type: AuthCredentialsDto, examples: { login: { value: { email: 'alan@example.com', password: 'correct-horse-battery-staple' } } } })
  @ApiOkResponse({ description: 'Authenticated.', type: AuthenticatedUserDto })
  @ApiBadRequestResponse({ description: 'Email and password are required.' })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  async login(@Body() body: AuthCredentialsDto): Promise<AuthenticatedUserDto> {
    if (!isCredentials(body)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Email and password are required.' });
    try {
      return await this.authenticateUser.execute(body.email, body.password);
    } catch (error: unknown) {
      if (error instanceof InvalidCredentialsError) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: error.message });
      throw error;
    }
  }

  @Post('session')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inspect the authenticated session', description: 'Demonstrates bearer-token validation and returns the token subject.' })
  @ApiOkResponse({ description: 'The token is valid.' })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, or expired access token.' })
  session(@Req() request: AuthenticatedRequest): { userId: string; email: string } {
    if (!request.user) throw new UnauthorizedException('A valid bearer token is required');
    return { userId: request.user.id, email: request.user.email };
  }
}
