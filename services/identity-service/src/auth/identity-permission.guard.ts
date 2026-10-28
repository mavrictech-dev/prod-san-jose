import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  hasRequiredPermissions,
  type AccessTokenClaims,
  type PermissionCode,
} from "@factuez/contracts";
import { AuthService } from "../application/auth.service";

export const REQUIRED_PERMISSIONS_KEY = "factuez:required-permissions";
export const RequiredPermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AccessTokenClaims;
};

@Injectable()
export class IdentityPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string"
        ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
        : undefined;
    if (!token)
      throw new UnauthorizedException("Se requiere un access token Bearer");

    const claims = this.auth.verifyAccessToken(token);
    await this.auth.assertActive(claims);
    const required =
      this.reflector.getAllAndOverride<PermissionCode[]>(
        REQUIRED_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    if (!hasRequiredPermissions(claims.permissions, required)) {
      throw new ForbiddenException(
        "El usuario no tiene los permisos requeridos",
      );
    }
    request.user = claims;
    return true;
  }
}
