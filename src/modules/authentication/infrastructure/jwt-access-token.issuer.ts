import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from '../domain/auth-user.js';
import { AccessTokenIssuer } from '../domain/authentication.ports.js';

@Injectable()
export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  constructor(private readonly jwt: JwtService) {}

  issue(user: Pick<AuthUser, 'id' | 'email'>): Promise<string> {
    return this.jwt.signAsync({ sub: user.id, email: user.email });
  }
}
