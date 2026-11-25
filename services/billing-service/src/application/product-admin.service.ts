import {GRE_GOODS_FAMILIES} from '@factuez/contracts/production-guides';
import {looksLikeFuel} from '@factuez/sunat-core/dist/production-guides';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionCodes } from '@factuez/contracts';
import type { AuthenticatedRequest } from '../auth/jwt-permission.guard';
import { PrismaService } from '../infrastructure/prisma.service';

const select = { greGoodsFamily:true, id: true, sku: true, description: true, category: true, categoryId: true, sunatProductCode: true, unitCode: true, taxAffectationCode: true, defaultUnitPrice: true, active: true, updatedAt: true } as const;
@Injectable()
export class ProductAdminService {
  constructor(private readonly prisma: PrismaService) {}
  private actor(request: AuthenticatedRequest) {
    const user = request.user;
    if (!user || user.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN') || !user.permissions.includes(PermissionCodes.PRODUCT_MANAGE))
      throw new ForbiddenException('El catálogo compartido sólo puede modificarse por el administrador general con permiso de productos');
    return user;
  }
  async list(request: AuthenticatedRequest) {
    this.actor(request);
    const rows=await this.prisma.fuelProduct.findMany({ select:{...select,categoryMaster:{select:{name:true}}}, orderBy: [{ description: 'asc' }, { id: 'asc' }] });
    return rows.map(({categoryMaster,...product})=>({...product,category:categoryMaster?.name??product.category}));
  }
  async save(productId: string | undefined, input: unknown, request: AuthenticatedRequest) {
    const actor = this.actor(request);
    if (productId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) throw new BadRequestException('Producto inválido');
    const fields = ['greGoodsFamily','sku', 'description', 'categoryId', 'sunatProductCode', 'unitCode', 'taxAffectationCode', 'defaultUnitPrice', 'active'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => ![...fields, 'expectedUpdatedAt'].includes(key))) throw new BadRequestException('Campos del producto inválidos');
    const body = input as Record<string, unknown>;
    const data: Record<string, any> = {};
    if(Object.hasOwn(body,'greGoodsFamily')){if(!GRE_GOODS_FAMILIES.includes(body.greGoodsFamily as any))throw new BadRequestException('Clasificación GRE inválida');data.greGoodsFamily=body.greGoodsFamily;}

    for (const [field, max] of [['sku', 40], ['description', 250]] as const) {
      if (!productId || Object.hasOwn(body, field)) {
        if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > max || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(body[field])) throw new BadRequestException(`Campo ${field} inválido`);
        data[field] = body[field].trim();
      }
    }
    for (const field of ['unitCode', 'taxAffectationCode'] as const) if (!productId || Object.hasOwn(body, field)) {
      const pattern = field === 'unitCode' ? /^(?:[A-Z0-9]{3}|ZZ|M3)$/ : /^10$/;
      if (typeof body[field] !== 'string' || !pattern.test(body[field])) {
        const message=field==='taxAffectationCode'
          ? 'El código de afectación no es el porcentaje de IGV. El catálogo compartido usa 10; configure la tasa y la exoneración permitida en la política tributaria del RUC o sede.'
          : 'Seleccione una unidad activa del catálogo de medidas, por ejemplo GLL o NIU.';
        throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',message,fieldErrors:{[field]:message}});
      }
      data[field] = body[field];
    }
    if (!productId || Object.hasOwn(body, 'categoryId')) {
      if (typeof body.categoryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.categoryId)) throw new BadRequestException('Seleccione una categoría del catálogo');
      data.categoryId = body.categoryId;
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
      const existingProduct=productId?await tx.fuelProduct.findUnique({where:{id:productId}}):null;
      if((data.greGoodsFamily??existingProduct?.greGoodsFamily)==='NON_REGULATED'&&looksLikeFuel({code:data.sku??existingProduct?.sku??'',description:data.description??existingProduct?.description??''}))throw new BadRequestException('Un combustible requiere familia GRE de hidrocarburos; no puede clasificarse como no regulado');
      if (data.categoryId) {
        const category = await tx.productCategory.findUnique({ where: { id: data.categoryId } });
        const prior = productId ? await tx.fuelProduct.findUnique({where:{id:productId}}) : null;
        if (!category || !category.active && prior?.categoryId !== category.id) throw new BadRequestException('Categoría inactiva o no disponible');
        data.category = category.name;
      }
      if (data.unitCode) {
        const unit = await tx.productUnit.findUnique({where:{code:data.unitCode}});
        const prior = productId ? await tx.fuelProduct.findUnique({where:{id:productId}}) : null;
        if (!unit || !unit.active && prior?.unitCode !== unit.code) throw new BadRequestException('Unidad inactiva o no disponible');
      }
      const row = productId ? await tx.fuelProduct.update({ where: { id: productId }, data, select }) : await tx.fuelProduct.create({ data: data as any, select });
      await tx.configurationAudit.create({ data: { actorId: actor.sub, action: productId ? data.active === false ? 'product.deactivated' : 'product.updated' : 'product.created', entityId: row.id, metadata: { sharedCatalog: true, changedFields: Object.keys(data), historicalDocumentsChanged: false } } });
      return row;
    }); } catch (error) { if ((error as { code?: string }).code === 'P2002') throw new ConflictException({message:'El SKU ya está registrado',fieldErrors:{sku:'Este SKU ya existe. Elija otro código.'}}); throw error; }
  }
}
