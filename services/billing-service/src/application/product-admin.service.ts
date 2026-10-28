import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import type { AuthenticatedRequest } from '../auth/jwt-permission.guard';
import { PrismaService } from '../infrastructure/prisma.service';

const select = { id: true, sku: true, description: true, category: true, sunatProductCode: true, unitCode: true, taxAffectationCode: true, defaultUnitPrice: true, active: true, updatedAt: true } as const;
@Injectable()
export class ProductAdminService {
  constructor(private readonly prisma: PrismaService) {}
  private actor(request: AuthenticatedRequest) {
    const user = request.user;
    if (!user || user.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN') || !user.permissions.includes(PermissionCodes.PRODUCT_MANAGE))
      throw new ForbiddenException('El catálogo compartido sólo puede modificarse por el administrador general con permiso de productos');
    return user;
  }
  list(request: AuthenticatedRequest) {
    this.actor(request);
    return this.prisma.fuelProduct.findMany({ select, orderBy: [{ description: 'asc' }, { id: 'asc' }] });
  }
  async save(productId: string | undefined, input: unknown, request: AuthenticatedRequest) {
    const actor = this.actor(request);
    if (productId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) throw new BadRequestException('Producto inválido');
    const fields = ['sku', 'description', 'category', 'sunatProductCode', 'unitCode', 'taxAffectationCode', 'defaultUnitPrice', 'active'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => ![...fields, 'expectedUpdatedAt'].includes(key))) throw new BadRequestException('Campos del producto inválidos');
    const body = input as Record<string, unknown>;
    const data: Record<string, any> = {};
    for (const [field, max] of [['sku', 40], ['description', 250], ['category', 80]] as const) {
      if (!productId || Object.hasOwn(body, field)) {
        if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > max || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(body[field])) throw new BadRequestException(`Campo ${field} inválido`);
        data[field] = body[field].trim();
      }
    }
    for (const field of ['unitCode', 'taxAffectationCode'] as const) if (!productId || Object.hasOwn(body, field)) {
      const pattern = field === 'unitCode' ? /^(?:[A-Z0-9]{3}|ZZ|M3)$/ : /^(10|11|12|13|14|15|16|17|20|21|30|31|32|33|34|35|36|37|40)$/;
      if (typeof body[field] !== 'string' || !pattern.test(body[field])) throw new BadRequestException(`Campo ${field} inválido`);
      data[field] = body[field];
    }
    if (Object.hasOwn(body, 'sunatProductCode')) {
      if (body.sunatProductCode !== null && (typeof body.sunatProductCode !== 'string' || !/^\d{8}$/.test(body.sunatProductCode))) throw new BadRequestException('Código de producto SUNAT inválido');
      data.sunatProductCode = body.sunatProductCode;
    }
    if (Object.hasOwn(body, 'defaultUnitPrice')) {
      if (body.defaultUnitPrice !== null && (typeof body.defaultUnitPrice !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(body.defaultUnitPrice))) throw new BadRequestException('Precio inválido; use hasta 6 decimales');
      data.defaultUnitPrice = body.defaultUnitPrice;
    }
    if (Object.hasOwn(body, 'active')) { if (typeof body.active !== 'boolean') throw new BadRequestException('Estado inválido'); data.active = body.active; }
    if (!Object.keys(data).length) throw new BadRequestException('No hay cambios');
    if (productId && (typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt)))) throw new BadRequestException('Se requiere la versión actual del producto');
    try { return await this.prisma.$transaction(async tx => {
      if (productId) {
        await tx.$queryRaw`SELECT id FROM "FuelProduct" WHERE id = ${productId}::uuid FOR UPDATE`;
        const before = await tx.fuelProduct.findUnique({ where: { id: productId }, select });
        if (!before) throw new NotFoundException('Producto no disponible');
        if (before.updatedAt.toISOString() !== body.expectedUpdatedAt) throw new ConflictException('El producto cambió. Recargue antes de guardar');
      }
      const row = productId ? await tx.fuelProduct.update({ where: { id: productId }, data, select }) : await tx.fuelProduct.create({ data: data as any, select });
      await tx.configurationAudit.create({ data: { actorId: actor.sub, action: productId ? data.active === false ? 'product.deactivated' : 'product.updated' : 'product.created', entityId: row.id, metadata: { sharedCatalog: true, changedFields: Object.keys(data), historicalDocumentsChanged: false } } });
      return row;
    }); } catch (error) { if ((error as { code?: string }).code === 'P2002') throw new ConflictException('El SKU ya está registrado'); throw error; }
  }
}
