import { Inject, CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCESS_TOKEN_VERIFIER } from '../../../modules/authentication/application/access-token-verifier.port.js';
import type { AccessTokenVerifier, AuthenticatedIdentity } from '../../../modules/authentication/application/access-token-verifier.port.js';
import type { Request } from 'express';

const IS_PUBLIC = 'isPublic';

export const Public = () => SetMetadata(IS_PUBLIC, true);

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedIdentity;
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token || authorization?.split(' ').length !== 2) throw new UnauthorizedException('A valid bearer token is required');

    try {
      request.user = await this.verifier.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException('A valid bearer token is required');
    }
  }
}
