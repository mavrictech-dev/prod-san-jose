import { Module } from '@nestjs/common';
import { OnpremB2bAdminModule } from './b2b/onprem-admin.module';
import { RbacBootstrapService } from './application/rbac-bootstrap.service';
import { PasswordService } from './application/password.service';
import { AuthService } from './application/auth.service';
import { UserAdministrationService } from './application/user-administration.service';
import { IdentityPermissionGuard } from './auth/identity-permission.guard';
import { AuthController } from './auth.controller';
import { HealthController } from './health.controller';
import { PrismaService } from './infrastructure/prisma.service';
import { JwksController } from './jwks.controller';
import { UsersController } from './users.controller';
import { BrowserSessionStore } from './application/browser-session.store';
import { BrowserSessionController } from './browser-session.controller';
import { UserPermissionsService } from './application/user-permissions.service';

@Module({
  imports: [OnpremB2bAdminModule],
  controllers: [HealthController, AuthController, UsersController, JwksController, BrowserSessionController],
  providers: [
    PrismaService,
    PasswordService,
    AuthService,
    BrowserSessionStore,
    UserAdministrationService,
    UserPermissionsService,
    RbacBootstrapService,
    IdentityPermissionGuard,
  ],
})
export class AppModule {}
