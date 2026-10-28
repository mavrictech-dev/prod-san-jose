import { Module } from '@nestjs/common';
import { PrismaService } from './infrastructure/prisma.service';
import { JwtPermissionGuard } from './auth/jwt-permission.guard';
import { ProductionNotesOwnerController } from './production-notes.controller';
import { ProductionNotesOwnerService } from './application/production-notes-owner.service';
import { ProductionNotesOwnerRuntime } from './application/production-notes-runtime.service';
export const PRODUCTION_NOTES_BILLING_PROVIDERS = [ProductionNotesOwnerService, ProductionNotesOwnerRuntime];
export const PRODUCTION_NOTES_BILLING_CONTROLLERS = [ProductionNotesOwnerController];
@Module({ controllers: PRODUCTION_NOTES_BILLING_CONTROLLERS, providers: [PrismaService, JwtPermissionGuard, ...PRODUCTION_NOTES_BILLING_PROVIDERS], exports: PRODUCTION_NOTES_BILLING_PROVIDERS })
export class ProductionNotesBillingModule {
}
