import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  PermissionCodes,
  RoleCodes,
} from "@factuez/contracts";
import {
  SAN_JOSE_CLIENT_INTAKE_V1,
  buildClientIntakeReport,
} from "@factuez/contracts/client-intake";
import {
  JwtPermissionGuard,
  RequiredPermissions,
  type AuthenticatedRequest,
} from "./auth/jwt-permission.guard";

/** Lectura del expediente parcial, no registro de emisores ni de historial. */
@Controller("api/v1/stations/client-intake")
@UseGuards(JwtPermissionGuard)
export class ClientIntakeController {
  @Get()
  @RequiredPermissions(PermissionCodes.SETUP_MANAGE)
  @Header("Cache-Control", "private, no-store")
  @Header("Vary", "Authorization")
  read(@Req() request: AuthenticatedRequest) {
    const actor = request.user;
    if (
      actor?.scope.kind !== "GLOBAL" ||
      !actor.roles.includes(RoleCodes.ADMIN) ||
      !actor.permissions.includes(PermissionCodes.SETUP_MANAGE)
    ) {
      throw new ForbiddenException(
        "La entrega del cliente requiere un administrador general.",
      );
    }
    if (process.env.CLIENT_INTAKE_QA_ENABLED !== "true") {
      throw new NotFoundException("Preparación del cliente no habilitada en QA.");
    }
    return buildClientIntakeReport(SAN_JOSE_CLIENT_INTAKE_V1);
  }
}
