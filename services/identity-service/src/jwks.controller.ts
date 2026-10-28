import { Controller, Get } from '@nestjs/common';
import { AuthService } from './application/auth.service';

@Controller('.well-known')
export class JwksController {
  constructor(private readonly auth: AuthService) {}

  @Get('jwks.json')
  jwks() {
    return this.auth.jwks();
  }
}
