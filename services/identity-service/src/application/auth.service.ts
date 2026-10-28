import {
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  PermissionCodes,
  RoleCodes,
  validScope,
  isSeriesCounterId,
  type AccessTokenClaims,
  type PermissionCode,
  type RoleCode,
} from "@factuez/contracts";
import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  randomUUID,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { PasswordService } from "./password.service";
import { PrismaService } from "../infrastructure/prisma.service";
import { BrowserSessionStore } from './browser-session.store';
import { UserPermissionsService } from './user-permissions.service';

const databasePermissionToApiCode: Record<string, PermissionCode> = {
  SETUP_MANAGE: PermissionCodes.SETUP_MANAGE,
  USER_MANAGE: PermissionCodes.USER_MANAGE,
  ROLE_MANAGE: PermissionCodes.ROLE_MANAGE,
  PRODUCT_MANAGE: PermissionCodes.PRODUCT_MANAGE,
  SERIES_MANAGE: PermissionCodes.SERIES_MANAGE,
  SUNAT_CONFIGURE: PermissionCodes.SUNAT_CONFIGURE,
  DOCUMENT_ISSUE: PermissionCodes.DOCUMENT_ISSUE,
  DOCUMENT_VIEW: PermissionCodes.DOCUMENT_VIEW,
  DOCUMENT_RETRY: PermissionCodes.DOCUMENT_RETRY,
  DOCUMENT_EMAIL: PermissionCodes.DOCUMENT_EMAIL,
  SHIFT_OPEN: PermissionCodes.SHIFT_OPEN,
  SHIFT_CLOSE: PermissionCodes.SHIFT_CLOSE,
  REPORT_VIEW: PermissionCodes.REPORT_VIEW,
  REPORT_EXPORT: PermissionCodes.REPORT_EXPORT,
  AUDIT_VIEW: PermissionCodes.AUDIT_VIEW,
};

type AuthenticatedUserRecord = {
  id: string;
  username: string;
  fullName: string;
  authVersion: number;
  passwordHash: string;
  active: boolean;
  roles: Array<{
    role: {
      code: string;
      active: boolean;
      permissions: Array<{ permission: { code: string } }>;
    };
  }>;
  emissionPoints: Array<{ emissionPointId: string }>;
  branches: Array<{ branchId: string }>;
  series: Array<{ series: string }>;
};

@Injectable()
export class AuthService {
  private privateKey?: Buffer;
  private publicKey?: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    @Optional() private readonly browserSessions?: BrowserSessionStore,
    @Optional() private readonly userPermissions?: UserPermissionsService,
  ) {}

  async login(username: string, password: string) {
    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.length > 80 ||
      typeof password !== "string" ||
      !password ||
      password.length > 256
    )
      throw new BadRequestException("Usuario y contraseña son obligatorios");
    const user = (await this.prisma.user.findUnique({
      where: { username: username.trim() },
      include: {
        roles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
        emissionPoints: true,
        branches: true,
        series: true,
      },
    })) as unknown as AuthenticatedUserRecord | null;
    if (
      !user?.active ||
      !(await this.passwords.verify(password, user.passwordHash))
    ) {
      throw new UnauthorizedException("Usuario o contraseña inválidos");
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.tokenForUser(user);
  }

  async browserAccess(userId: string, authVersion: number, browserSessionId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      emissionPoints: true, branches: true, series: true,
    } }) as unknown as AuthenticatedUserRecord | null;
    if (!user?.active || user.authVersion !== authVersion) throw new UnauthorizedException('Su acceso cambió. Inicie sesión nuevamente.');
    return this.tokenForUser(user, browserSessionId);
  }

  private async tokenForUser(user: AuthenticatedUserRecord, browserSessionId?: string) {
    const activeRoles = user.roles
      .map(({ role }) => role)
      .filter((role) => role.active);
    if (!activeRoles.length)
      throw new UnauthorizedException("El usuario no tiene un rol activo");
    const roles = [
      ...new Set(activeRoles.map((role) => role.code as RoleCode)),
    ];
    const permissions = [
      ...new Set(
        [...activeRoles.flatMap((role) =>
          role.permissions.map(
            ({ permission }) => databasePermissionToApiCode[permission.code],
          ),
        ), ...(this.userPermissions ? await this.userPermissions.effective(user.id) : [])],
      ),
    ].filter((permission): permission is PermissionCode => Boolean(permission));

    const hasGlobalEmissionScope = roles.includes(RoleCodes.ADMIN);
    return {
      accessToken: this.sign({
        sub: user.id,
        username: user.username,
        fullName: user.fullName,
        authVersion: user.authVersion,
        ...(browserSessionId ? { browserSessionId } : {}),
        scope: hasGlobalEmissionScope
          ? { kind: "GLOBAL" }
          : {
              kind: "ASSIGNED",
              branchIds: user.branches.map((item) => item.branchId),
              emissionPointIds: user.emissionPoints.map(
                (item) => item.emissionPointId,
              ),
              series: user.series
                .map((item) => item.series)
                .filter(isSeriesCounterId),
            },
        roles,
        permissions,
        emissionPointIds: hasGlobalEmissionScope
          ? undefined
          : user.emissionPoints.map((assignment) => assignment.emissionPointId),
      }),
      tokenType: "Bearer",
      expiresIn: this.accessTokenLifetimeSeconds(),
    };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
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
      !Number.isInteger(claims.authVersion) ||
      (claims.browserSessionId !== undefined && (typeof claims.browserSessionId !== 'string' || !/^[a-f0-9]{64}$/.test(claims.browserSessionId)))
    ) {
      throw new UnauthorizedException(
        "Debe iniciar sesión de nuevo para actualizar su alcance",
      );
    }
    return claims;
  }

  async assertActive(claims: Pick<AccessTokenClaims, 'sub' | 'authVersion' | 'browserSessionId'>) {
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { active: true, authVersion: true },
    });
    if (!user?.active || user.authVersion !== claims.authVersion) {
      throw new UnauthorizedException(
        "Su acceso cambió. Inicie sesión nuevamente.",
      );
    }
    if (claims.browserSessionId) {
      if (!this.browserSessions) throw new ServiceUnavailableException('Servicio de sesiones no disponible');
      const session = await this.browserSessions.get(claims.browserSessionId);
      if (session.userId !== claims.sub || session.authVersion !== claims.authVersion) throw new UnauthorizedException('Sesión inválida');
    }
  }

  jwks() {
    const jwk = createPublicKey(this.getPublicKey()).export({
      format: "jwk",
    }) as Record<string, string>;
    return {
      keys: [{ ...jwk, kid: this.keyId(), alg: "RS256", use: "sig" }],
    };
  }

  private sign(
    input: Pick<
      AccessTokenClaims,
      | "sub"
      | "username"
      | "fullName"
      | "roles"
      | "permissions"
      | "emissionPointIds"
      | "scope"
      | "authVersion"
      | "browserSessionId"
    >,
  ): string {
    const now = Math.floor(Date.now() / 1_000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.keyId() }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        ...input,
        iss: process.env.JWT_ISSUER ?? "factuez-identity",
        aud: process.env.JWT_AUDIENCE ?? "factuez-services",
        iat: now,
        exp: now + this.accessTokenLifetimeSeconds(),
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(this.getPrivateKey()).toString("base64url")}`;
  }

  private accessTokenLifetimeSeconds(): number {
    const configured = Number(process.env.JWT_ACCESS_TOKEN_TTL_SECONDS ?? 900);
    if (
      !Number.isInteger(configured) ||
      configured < 60 ||
      configured > 3_600
    ) {
      throw new Error(
        "JWT_ACCESS_TOKEN_TTL_SECONDS debe estar entre 60 y 3600",
      );
    }
    return configured;
  }

  private getPrivateKey(): Buffer {
    if (!this.privateKey) {
      const path = process.env.JWT_PRIVATE_KEY_FILE;
      if (!path) throw new Error("JWT_PRIVATE_KEY_FILE no está configurado");
      this.privateKey = readFileSync(path);
    }
    return this.privateKey;
  }

  private getPublicKey(): Buffer {
    if (!this.publicKey) {
      const path = process.env.JWT_PUBLIC_KEY_FILE;
      if (!path) throw new Error("JWT_PUBLIC_KEY_FILE no está configurado");
      this.publicKey = readFileSync(path);
    }
    return this.publicKey;
  }

  private keyId(): string {
    return createHash("sha256").update(this.getPublicKey()).digest("base64url");
  }
}
