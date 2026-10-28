import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { PermissionCodes } from "@factuez/contracts";
import { UserPermissionsService } from './application/user-permissions.service';
import {
  type CreateUserInput,
  type UpdateUserAccessInput,
  UserAdministrationService,
} from "./application/user-administration.service";
import {
  IdentityPermissionGuard,
  RequiredPermissions,
  type AuthenticatedRequest,
} from "./auth/identity-permission.guard";

@Controller("api/v1")
@UseGuards(IdentityPermissionGuard)
export class UsersController {
  constructor(private readonly users: UserAdministrationService, private readonly extra: UserPermissionsService) {}
  @Get('users/:id/permissions')
  @RequiredPermissions(PermissionCodes.USER_MANAGE, PermissionCodes.ROLE_MANAGE)
  userPermissions(@Param('id') id: string, @Req() request: AuthenticatedRequest) { return this.extra.status(id, request.user!); }
  @Patch('users/:id/permissions')
  @RequiredPermissions(PermissionCodes.USER_MANAGE, PermissionCodes.ROLE_MANAGE)
  updateUserPermissions(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) { return this.extra.update(id, body, request.user!); }

  @Get("roles")
  @RequiredPermissions(PermissionCodes.ROLE_MANAGE)
  roles(@Req() request: AuthenticatedRequest) {
    return this.users.listRoles(request.user!);
  }
  @Patch("roles/:code")
  @RequiredPermissions(PermissionCodes.ROLE_MANAGE)
  updateRole(@Param("code") code: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.users.updateRole(code, body, request.user!);
  }

  @Get("users")
  @RequiredPermissions(PermissionCodes.USER_MANAGE)
  usersList(@Req() request: AuthenticatedRequest) {
    return this.users.listUsers(request.user!);
  }

  @Post("users")
  @RequiredPermissions(PermissionCodes.USER_MANAGE, PermissionCodes.ROLE_MANAGE)
  create(@Body() body: CreateUserInput, @Req() request: AuthenticatedRequest) {
    return this.users.create(
      body,
      request.user!,
      request.headers.authorization as string,
    );
  }

  @Patch("users/:id/access")
  @RequiredPermissions(PermissionCodes.USER_MANAGE, PermissionCodes.ROLE_MANAGE)
  updateAccess(
    @Param("id") userId: string,
    @Body() body: UpdateUserAccessInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.users.updateAccess(
      userId,
      body,
      request.user!,
      request.headers.authorization as string,
    );
  }
}
