import { CanActivate, ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { PermissionCodes, RoleCodes, validScope, type AccessTokenClaims } from "@factuez/contracts";

export type ConfigurationRequest = { headers: { authorization?: string }; user?: AccessTokenClaims };

/** Identity verifica firma/vigencia/revocación. No se comparten tablas o claves. */
@Injectable()
export class FiscalIssuanceGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ConfigurationRequest>();
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization))
      throw new UnauthorizedException("Inicie sesión para configurar SUNAT");
    let response: Response;
    try {
      response = await fetch(`${process.env.IDENTITY_INTERNAL_URL ?? "http://identity-service:3001"}/api/v1/auth/me`, {
        headers: { Authorization: authorization, Accept: "application/json", "Cache-Control": "no-store" },
        signal: AbortSignal.timeout(4000), redirect: "error",
      });
    } catch { throw new ServiceUnavailableException("No se pudo verificar la identidad"); }
    if ([401, 403].includes(response.status)) throw new UnauthorizedException("Su acceso cambió. Inicie sesión nuevamente");
    if (!response.ok) throw new ServiceUnavailableException("Identidad no está disponible");
    let claims: AccessTokenClaims;
    try { claims = await response.json() as AccessTokenClaims; }
    catch { throw new ServiceUnavailableException("Respuesta de identidad inválida"); }
    if (!claims.sub || !Array.isArray(claims.roles) || !Array.isArray(claims.permissions) || !validScope(claims.scope, claims.roles))
      throw new ServiceUnavailableException("Respuesta de identidad inválida");
    if (!claims.permissions.includes(PermissionCodes.DOCUMENT_ISSUE))
      throw new ForbiddenException("Su cuenta no tiene permiso para emitir comprobantes");
    request.user = claims;
    return true;
  }
}
