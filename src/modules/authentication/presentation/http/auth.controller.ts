import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedIdentity } from '../../application/access-token-verifier.port.js';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedIdentity;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  @Get('session')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Inspect the identity verified from the Keycloak access token' })
  @ApiOkResponse({ description: 'The access token is valid.', schema: { example: { userId: 'keycloak-subject', email: 'alan@example.com' } } })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or incorrectly scoped access token.' })
  session(@Req() request: AuthenticatedRequest): { userId: string; email?: string } {
    if (!request.user) throw new UnauthorizedException('A valid bearer token is required');
    return { userId: request.user.id, ...(request.user.email ? { email: request.user.email } : {}) };
  }
}
