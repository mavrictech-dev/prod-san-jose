import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  hasRequiredPermissions,
  validScope,
  type AccessTokenClaims,
  type PermissionCode,
} from "@factuez/contracts";
import { createVerify } from "node:crypto";
import { readFileSync } from "node:fs";

export const REQUIRED_PERMISSIONS_KEY = "factuez:required-permissions";
export const RequiredPermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AccessTokenClaims;
};

/**
 * Verifica access tokens RS256 emitidos por identity-service. Los servicios no
 * aceptan headers de identidad ni permisos enviados por el cliente.
 */
@Injectable()
export class JwtPermissionGuard implements CanActivate {
  private publicKey?: Buffer;

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const bearer =
      typeof authorization === "string"
        ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
        : undefined;
    if (!bearer)
      throw new UnauthorizedException("Se requiere un access token Bearer");

    const claims = this.verify(bearer);
    // Verificación de revocación sin compartir tablas ni claves privadas.
    let current: Response;
    try {
      current = await fetch(
        `${process.env.IDENTITY_INTERNAL_URL ?? "http://identity-service:3001"}/api/v1/auth/me`,
        {
          headers: { Authorization: `Bearer ${bearer}` },
          signal: AbortSignal.timeout(4000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "No se pudo verificar el acceso. Reintente.",
      );
    }
    if (current.status === 401 || current.status === 403)
      throw new UnauthorizedException(
        "Su acceso cambió. Inicie sesión nuevamente.",
      );
    if (!current.ok)
      throw new ServiceUnavailableException("Identidad no está disponible");
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

  private verify(token: string): AccessTokenClaims {
    const [encodedHeader, encodedPayload, encodedSignature, ...extra] =
      token.split(".");
    if (
      !encodedHeader ||
      !encodedPayload ||
      !encodedSignature ||
      extra.length
    ) {
      throw new UnauthorizedException("Formato de access token inválido");
    }

    let header: { alg?: unknown };
    let claims: AccessTokenClaims;
    try {
      header = JSON.parse(
        Buffer.from(encodedHeader, "base64url").toString("utf8"),
      ) as { alg?: unknown };
      claims = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8"),
      ) as AccessTokenClaims;
    } catch {
      throw new UnauthorizedException("Access token no puede decodificarse");
    }
    if (header.alg !== "RS256")
      throw new UnauthorizedException("Algoritmo de access token no permitido");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    if (
      !verifier.verify(
        this.getPublicKey(),
        Buffer.from(encodedSignature, "base64url"),
      )
    ) {
      throw new UnauthorizedException("Firma de access token inválida");
    }

    const now = Math.floor(Date.now() / 1_000);
    const audience = process.env.JWT_AUDIENCE ?? "factuez-services";
    const issuer = process.env.JWT_ISSUER ?? "factuez-identity";
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !claims.sub ||
      !claims.username ||
      !Array.isArray(claims.roles) ||
      !Array.isArray(claims.permissions) ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= now ||
      claims.iss !== issuer ||
      !audiences.includes(audience)
    ) {
      throw new UnauthorizedException(
        "Claims de access token inválidos o expirados",
      );
    }
    if (
      !validScope(claims.scope, claims.roles) ||
      !Number.isInteger(claims.authVersion)
    ) {
      throw new UnauthorizedException(
        "Token sin alcance explícito. Inicie sesión nuevamente.",
      );
    }
    return claims;
  }

  private getPublicKey(): Buffer {
    if (!this.publicKey) {
      const path = process.env.JWT_PUBLIC_KEY_FILE;
      if (!path) throw new Error("JWT_PUBLIC_KEY_FILE no está configurado");
      this.publicKey = readFileSync(path);
    }
    return this.publicKey;
  }
}
