import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthService } from "./application/auth.service";
import {
  IdentityPermissionGuard,
  type AuthenticatedRequest,
} from "./auth/identity-permission.guard";

@Controller("api/v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(200)
  login(@Body() body: { username: string; password: string }) {
    return this.auth.login(body?.username, body?.password);
  }

  @Get("me")
  @UseGuards(IdentityPermissionGuard)
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }
}
