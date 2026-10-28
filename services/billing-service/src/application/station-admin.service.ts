import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PermissionCodes, STATION_ADMIN_VERSION, type AccessTokenClaims, type PermissionCode, type StationAdminCatalog,
  type StationIssuer, type StationBranch, type StationPoint, type StationSeries, type StationSeriesType } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import type { AuthenticatedRequest } from '../auth/jwt-permission.guard';

type Tx = PrismaService;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const issuerSelect = { id: true, ruc: true, legalName: true, tradeName: true, taxAddress: true, ubigeo: true,
  phone: true, contactEmails: true, environment: true, active: true, configVersion: true } as const;
const seriesTypes: StationSeriesType[] = ['INVOICE', 'SALES_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'DESPATCH_ADVICE'];

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)))
    throw new BadRequestException('Campos no admitidos. No se editan RUC, propietarios ni correlativos.');
  return input as Record<string, unknown>;
}
function text(input: unknown, label: string, maximum: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(input))
    throw new BadRequestException(`${label} inválido`);
  return input.trim();
}
function optionalText(input: unknown, label: string, maximum: number): string | null {
  return input === null || input === '' ? null : text(input, label, maximum);
}
function code(input: unknown): string {
  const value = text(input, 'Código', 20).toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(value)) throw new BadRequestException('Código inválido');
  return value;
}
function establishmentCode(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string' || input.length !== 4 || !/^[0-9]{4}$/.test(input))
    throw new BadRequestException('Establecimiento SUNAT: use exactamente 4 dígitos o null para quitarlo');
  return input;
}
function id(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) throw new BadRequestException('Identificador inválido');
  return input.toLowerCase();
}
function companyId(input: unknown): number {
  const value = typeof input === 'string' && /^[1-9]\d{0,9}$/.test(input) ? Number(input) : input;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647) throw new BadRequestException('Emisor inválido');
  return Number(value);
}
function revision(body: Record<string, unknown>, actual: number): void {
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new BadRequestException('Se requiere la revisión vigente');
  if (body.expectedRevision !== actual) throw new ConflictException('El registro cambió. Recargue los maestros antes de guardar.');
}
function active(input: unknown): boolean {
  if (typeof input !== 'boolean') throw new BadRequestException('Estado inválido');
  return input;
}
function series(input: unknown, type: StationSeriesType): string {
  const value = text(input, 'Serie', 4).toUpperCase();
  const pattern = type === 'INVOICE' ? /^F[A-Z0-9]{3}$/ : type === 'SALES_RECEIPT' ? /^B[A-Z0-9]{3}$/
    : type === 'DESPATCH_ADVICE' ? /^T[A-Z0-9]{3}$/ : /^[FB][A-Z0-9]{3}$/;
  if (!pattern.test(value)) throw new BadRequestException('Serie inválida para el tipo de documento');
  return value;
}
function issuerData(body: Record<string, unknown>, creation: boolean) {
  const data: Record<string, any> = {};
  for (const [key, label, max] of [['legalName', 'Razón social', 200], ['taxAddress', 'Dirección fiscal', 300]] as const)
    if (creation || Object.hasOwn(body, key)) data[key] = text(body[key], label, max);
  if (creation || Object.hasOwn(body, 'ubigeo')) {
    if (typeof body.ubigeo !== 'string' || !/^\d{6}$/.test(body.ubigeo)) throw new BadRequestException('Ubigeo fiscal inválido');
    data.ubigeo = body.ubigeo;
  }
  for (const [key, label, max] of [['tradeName', 'Nombre comercial', 200], ['phone', 'Teléfono', 40]] as const)
    if (Object.hasOwn(body, key)) data[key] = optionalText(body[key], label, max);
  if (Object.hasOwn(body, 'contactEmails')) {
    if (!Array.isArray(body.contactEmails) || body.contactEmails.length > 10 || body.contactEmails.some(email =>
      typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new BadRequestException('Correos de contacto inválidos');
    data.contactEmails = [...new Set(body.contactEmails as string[])];
  }
  if (Object.hasOwn(body, 'active')) data.active = active(body.active);
  return data;
}
function masterData(body: Record<string, unknown>, creation: boolean, point = false) {
  const data: Record<string, any> = {};
  if (creation || Object.hasOwn(body, 'code')) data.code = code(body.code);
  if (creation || Object.hasOwn(body, 'name')) data.name = text(body.name, 'Nombre', 120);
  if (Object.hasOwn(body, 'address')) data.address = optionalText(body.address, 'Dirección', 300);
  if (point && Object.hasOwn(body, 'trackNumber')) {
    if (body.trackNumber !== null && (!Number.isSafeInteger(body.trackNumber) || Number(body.trackNumber) < 1 || Number(body.trackNumber) > 9999)) throw new BadRequestException('Número de pista inválido');
    data.trackNumber = body.trackNumber;
  }
  if (Object.hasOwn(body, 'active')) data.active = active(body.active);
  return data;
}

@Injectable()
export class StationAdminService {
  constructor(private readonly prisma: PrismaService) {}
  private authorize(request: AuthenticatedRequest, permission: PermissionCode) {
    const user = request.user;
    if (!user || user.scope.kind !== 'GLOBAL' || !user.roles?.includes('ADMIN') || !user.permissions?.includes(permission))
      throw new ForbiddenException('La administración de maestros requiere administrador general y el permiso correspondiente.');
    if (process.env.STATION_MASTER_CRUD_ENABLED !== 'true') throw new ServiceUnavailableException('El CRUD de maestros aún no está habilitado en este servidor.');
    return user;
  }
  private productionAllowed(request: AuthenticatedRequest): boolean {
    // The delegated B2B owner bridge supplies no human Bearer header and stays Beta-only.
    const authorization = request.headers?.authorization;
    return process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true' &&
      typeof authorization === 'string' && /^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization);
  }
  private async write<T>(request: AuthenticatedRequest, permission: PermissionCode, work: (tx: Tx, actor: AccessTokenClaims, production: boolean) => Promise<T>) {
    const actor = this.authorize(request, permission);
    try { return await this.prisma.$transaction(tx => work(tx as unknown as Tx, actor, this.productionAllowed(request))); }
    catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('El RUC, código o serie ya existe. No se modificó ningún correlativo.');
      if ((error as { code?: string }).code === 'P2025') throw new ConflictException('El registro cambió o no está disponible. Recargue.');
      throw error;
    }
  }
  private async lock(tx: Tx, table: 'CompanySettings' | 'Branch' | 'EmissionPoint' | 'SeriesCounter', value: string | number) {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1${table === 'CompanySettings' ? '' : '::uuid'} FOR UPDATE`, value);
  }
  private async company(tx: Tx, value: number, production = false) {
    await this.lock(tx, 'CompanySettings', value);
    const company = await tx.companySettings.findUnique({ where: { id: value }, select: issuerSelect });
    if (!company) throw new NotFoundException('Emisor no disponible');
    if (company.environment !== 'BETA' && !(production && company.environment === 'PRODUCTION' && process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true')) throw new ForbiddenException('Emisión de producción bloqueada: requiere el flag de emisión y acceso humano autorizado.');
    return company;
  }
  private requireActive(value: { active: boolean }, label: string) {
    if (!value.active) throw new ConflictException(`${label} inactivo. Reactívelo antes de habilitar sus dependencias.`);
  }
  private async branch(tx: Tx, value: string, production = false) {
    const initial = await tx.branch.findUnique({ where: { id: value } });
    if (!initial) throw new NotFoundException('Sede no disponible');
    const company = await this.company(tx, initial.companyId, production); await this.lock(tx, 'Branch', value);
    const branch = await tx.branch.findUniqueOrThrow({ where: { id: value } });
    if (branch.companyId !== company.id) throw new ConflictException('Cambió el emisor de la sede. Recargue.');
    return { company, branch };
  }
  private async point(tx: Tx, value: string, production = false) {
    const initial = await tx.emissionPoint.findUnique({ where: { id: value } });
    if (!initial?.branchId) throw new NotFoundException('Punto o sede no disponibles');
    const context = await this.branch(tx, initial.branchId, production); await this.lock(tx, 'EmissionPoint', value);
    const point = await tx.emissionPoint.findUniqueOrThrow({ where: { id: value } });
    if (point.companyId !== context.company.id || point.branchId !== context.branch.id) throw new ConflictException('Cambió el ámbito del punto. Recargue.');
    return { ...context, point };
  }
  private async counter(tx: Tx, value: string, production = false) {
    const initial = await tx.seriesCounter.findUnique({ where: { id: value } });
    if (!initial) throw new NotFoundException('Serie no disponible');
    const context = await this.point(tx, initial.emissionPointId, production); await this.lock(tx, 'SeriesCounter', value);
    const counter = await tx.seriesCounter.findUniqueOrThrow({ where: { id: value } });
    if (counter.companyId !== context.company.id || counter.emissionPointId !== context.point.id) throw new ConflictException('Cambió el ámbito de la serie. Recargue.');
    return { ...context, counter };
  }
  private async audit(tx: Tx, user: AccessTokenClaims, action: string, entityId: string | number, company: { id: number; ruc: string; environment?: string }, fields: string[], previousEnvironment?: string) {
    await tx.configurationAudit.create({ data: { actorId: user.sub, action, entityId: String(entityId),
      metadata: { companyId: company.id, issuerRuc: company.ruc, environment: company.environment ?? 'BETA', ...(previousEnvironment ? { previousEnvironment } : {}), changedFields: fields, softDelete: action.endsWith('.deactivated') } } });
  }
  private async noOpenShifts(tx: Tx, where: any) {
    if (await tx.shift.count({ where: { status: 'OPEN', emissionPoint: where } })) throw new ConflictException('Cierre los turnos abiertos antes de desactivar este registro.');
  }
  private issuerDto(value: any): StationIssuer {
    return { id: value.id, ruc: value.ruc, legalName: value.legalName, tradeName: value.tradeName ?? null, taxAddress: value.taxAddress,
      ubigeo: value.ubigeo, phone: value.phone ?? null, contactEmails: value.contactEmails, environment: value.environment, active: value.active, revision: value.configVersion };
  }

  async catalog(request: AuthenticatedRequest): Promise<StationAdminCatalog> {
    this.authorize(request, PermissionCodes.SETUP_MANAGE);
    const production = this.productionAllowed(request);
    return this.prisma.$transaction(async transaction => {
      const tx = transaction as unknown as Tx;
      const companies = await tx.companySettings.findMany({ where: { environment: production ? { in: ['BETA', 'PRODUCTION'] } : 'BETA' }, select: issuerSelect, orderBy: { legalName: 'asc' } });
      const companyIds = companies.map(company => company.id);
      const branches = await tx.branch.findMany({ where: { companyId: { in: companyIds } }, orderBy: { code: 'asc' }, include: { _count: { select: { emissionPoints: true } } } });
      const points = await tx.emissionPoint.findMany({ where: { companyId: { in: companyIds } }, orderBy: { code: 'asc' }, include: { _count: { select: { shifts: { where: { status: 'OPEN' } } } } } });
      const counters = await tx.seriesCounter.findMany({ where: { companyId: { in: companyIds } }, orderBy: [{ documentType: 'asc' }, { series: 'asc' }], include: { _count: { select: { documents: true } } } });
      const byCompany = new Map(companies.map(company => [company.id, company])); const byBranch = new Map(branches.map(branch => [branch.id, branch]));
      const branchDtos: StationBranch[] = branches.map(branch => ({ id: branch.id, companyId: branch.companyId, code: branch.code, name: branch.name,
        address: branch.address, establishmentCode: branch.establishmentCode, active: branch.active, effectiveActive: branch.active && !!byCompany.get(branch.companyId)?.active, revision: branch.masterRevision,
        pointCount: branch._count.emissionPoints, openShiftCount: points.filter(point => point.branchId === branch.id).reduce((sum, point) => sum + point._count.shifts, 0) }));
      const pointDtos: StationPoint[] = points.map(point => ({ id: point.id, companyId: point.companyId, branchId: point.branchId, code: point.code, name: point.name,
        address: point.address, trackNumber: point.trackNumber, active: point.active, effectiveActive: point.active && !!byCompany.get(point.companyId)?.active && !!(point.branchId && byBranch.get(point.branchId)?.active),
        revision: point.masterRevision, openShiftCount: point._count.shifts }));
      const byPoint = new Map(pointDtos.map(point => [point.id, point]));
      const seriesDtos: StationSeries[] = counters.map(counter => ({ id: counter.id, companyId: counter.companyId, emissionPointId: counter.emissionPointId,
        documentType: counter.documentType, series: counter.series, nextNumber: counter.nextNumber.toString(), active: counter.active,
        effectiveActive: counter.active && !!byPoint.get(counter.emissionPointId)?.effectiveActive, revision: counter.masterRevision,
        documentCount: counter._count.documents, canRename: counter.nextNumber === 1n && counter._count.documents === 0 }));
      return { version: STATION_ADMIN_VERSION, capabilities: { betaOnly: !production, softDelete: true, counterEditing: false }, companies: companies.map(company => this.issuerDto(company)),
        branches: branchDtos, emissionPoints: pointDtos, series: seriesDtos };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async createIssuer(input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['ruc', 'legalName', 'taxAddress', 'ubigeo', 'tradeName', 'phone', 'contactEmails']);
    if (typeof body.ruc !== 'string' || !/^\d{11}$/.test(body.ruc)) throw new BadRequestException('RUC de 11 dígitos requerido');
    const data = issuerData(body, true);
    return this.write(request, PermissionCodes.SETUP_MANAGE, async (tx, actor, production) => {
      const company = await tx.companySettings.create({ data: { ...data, ruc: body.ruc as string, legalName: data.legalName,
        taxAddress: data.taxAddress, ubigeo: data.ubigeo, companyType: 'Por configurar', economicActivities: [], contactEmails: data.contactEmails ?? [], environment: 'BETA', active: true }, select: issuerSelect });
      await this.audit(tx, actor, 'issuer.created', company.id, company, Object.keys(body)); return this.issuerDto(company);
    });
  }
  async updateIssuer(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['expectedRevision', 'legalName', 'taxAddress', 'ubigeo', 'tradeName', 'phone', 'contactEmails', 'active']); const data = issuerData(body, false);
    if (!Object.keys(data).length) throw new BadRequestException('No hay cambios para guardar');
    return this.write(request, PermissionCodes.SETUP_MANAGE, async (tx, actor, production) => {
      const current = await this.company(tx, companyId(value), production); revision(body, current.configVersion);
      if (data.active === false) await this.noOpenShifts(tx, { companyId: current.id });
      const result = await tx.companySettings.update({ where: { id: current.id }, data: { ...data, configVersion: { increment: 1 } }, select: issuerSelect });
      await this.audit(tx, actor, data.active === false ? 'issuer.deactivated' : data.active === true ? 'issuer.reactivated' : 'issuer.updated', current.id, current, Object.keys(data)); return this.issuerDto(result);
    });
  }
  /** One-way transition of an unused issuer; never migrates, resets or re-labels fiscal history. */
  async configureEnvironment(value: string, input: unknown, request: AuthenticatedRequest) {
    const actor = this.authorize(request, PermissionCodes.SETUP_MANAGE);
    if (!actor.permissions.includes(PermissionCodes.SUNAT_CONFIGURE))
      throw new ForbiddenException('Se requiere también el permiso de configuración SUNAT');
    if (process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED !== 'true')
      throw new ServiceUnavailableException('Emisión de producción bloqueada en este servidor');
    const body = object(input, ['expectedRevision', 'environment', 'confirmation']);
    if (Object.keys(body).length !== 3 || body.environment !== 'PRODUCTION' || body.confirmation !== 'CAMBIAR EMISOR A PRODUCCIÓN')
      throw new BadRequestException('Confirme explícitamente el cambio del emisor a Producción');
    return this.write(request, PermissionCodes.SETUP_MANAGE, async (tx, user) => {
      const current = await this.company(tx, companyId(value)); revision(body, current.configVersion);
      this.requireActive(current, 'Emisor');
      // Same hierarchy as issuance/CRUD; company lock prevents concurrent enrolment and issuance.
      for (const table of ['Branch', 'EmissionPoint', 'SeriesCounter'] as const)
        await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "companyId" = $1 ORDER BY "id" FOR UPDATE`, current.id);
      if (await tx.document.count({ where: { companyId: current.id } }) ||
        await tx.dailySummary.count({ where: { companyId: current.id } }) ||
        await tx.seriesCounter.count({ where: { companyId: current.id, nextNumber: { not: 1n } } }) ||
        await tx.outboxEvent.count({ where: { OR: [
          ...[current.id, String(current.id)].flatMap(equals => [
            { payload: { path: ['payload', 'companyId'], equals } }, { payload: { path: ['companyId'], equals } },
          ]),
          { payload: { path: ['payload', 'issuerRuc'], equals: current.ruc } },
          { payload: { path: ['payload', 'issuer', 'identityNumber'], equals: current.ruc } },
        ] } })) throw new ConflictException('Emisor con documentos, Outbox, resúmenes o numeración consumida; no se cambia su ambiente ni historial');
      const result = await tx.companySettings.update({
        where: { id: current.id, configVersion: current.configVersion, environment: 'BETA' },
        data: { environment: 'PRODUCTION', configVersion: { increment: 1 } }, select: issuerSelect,
      });
      await this.audit(tx, user, 'issuer.environment.changed', result.id, result, ['environment'], 'BETA');
      return { id: result.id, ruc: result.ruc, environment: result.environment, revision: result.configVersion };
    });
  }
  deactivateIssuer(value: string, input: unknown, request: AuthenticatedRequest) { return this.updateIssuer(value, { ...object(input, ['expectedRevision']), active: false }, request); }
  async createBranch(input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['companyId', 'code', 'name', 'address', 'establishmentCode']); const data = masterData(body, true);
    data.establishmentCode = Object.hasOwn(body, 'establishmentCode') ? establishmentCode(body.establishmentCode) : null;
    return this.write(request, PermissionCodes.SETUP_MANAGE, async (tx, actor, production) => {
      const company = await this.company(tx, companyId(body.companyId), production); this.requireActive(company, 'Emisor');
      const branch = await tx.branch.create({ data: { companyId: company.id, code: data.code, name: data.name, address: data.address, establishmentCode: data.establishmentCode } });
      await this.audit(tx, actor, 'branch.created', branch.id, company, Object.keys(data)); return { ...branch, revision: branch.masterRevision };
    });
  }
  async updateBranch(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['expectedRevision', 'code', 'name', 'address', 'active', 'establishmentCode']); const data = masterData(body, false);
    if (Object.hasOwn(body, 'establishmentCode')) data.establishmentCode = establishmentCode(body.establishmentCode);
    if (!Object.keys(data).length) throw new BadRequestException('No hay cambios para guardar');
    return this.write(request, PermissionCodes.SETUP_MANAGE, async (tx, actor, production) => {
      const context = await this.branch(tx, id(value), production); revision(body, context.branch.masterRevision);
      if (data.active === true) this.requireActive(context.company, 'Emisor'); if (data.active === false) await this.noOpenShifts(tx, { branchId: context.branch.id });
      const branch = await tx.branch.update({ where: { id: context.branch.id }, data: { ...data, masterRevision: { increment: 1 } } });
      await this.audit(tx, actor, data.active === false ? 'branch.deactivated' : data.active === true ? 'branch.reactivated' : 'branch.updated', branch.id, context.company, Object.keys(data)); return { ...branch, revision: branch.masterRevision };
    });
  }
  deactivateBranch(value: string, input: unknown, request: AuthenticatedRequest) { return this.updateBranch(value, { ...object(input, ['expectedRevision']), active: false }, request); }
  async assignIssuer(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['companyId', 'expectedRevision']); const branchId = id(value); const targetId = companyId(body.companyId);
    return this.write(request, PermissionCodes.SETUP_MANAGE, async (tx, actor, production) => {
      const initial = await tx.branch.findUnique({ where: { id: branchId } }); if (!initial) throw new NotFoundException('Sede no disponible');
      const companies = new Map<number, Awaited<ReturnType<StationAdminService['company']>>>();
      for (const key of [...new Set([initial.companyId, targetId])].sort((a, b) => a - b)) companies.set(key, await this.company(tx, key, production));
      await this.lock(tx, 'Branch', branchId); const branch = await tx.branch.findUniqueOrThrow({ where: { id: branchId } });
      if (branch.companyId !== initial.companyId) throw new ConflictException('Cambió el emisor de la sede. Recargue.');
      revision(body, branch.masterRevision); this.requireActive(branch, 'Sede'); this.requireActive(companies.get(targetId)!, 'Emisor');
      if (await tx.emissionPoint.count({ where: { branchId } })) throw new ConflictException('Esta sede ya tiene puntos de emisión. No se permite cambiar su RUC ni trasladar su historial.');
      const result = await tx.branch.update({ where: { id: branchId }, data: { companyId: targetId, masterRevision: { increment: 1 } } });
      await this.audit(tx, actor, 'branch.issuer.changed', branchId, companies.get(targetId)!, ['companyId']); return { ...result, revision: result.masterRevision };
    });
  }
  async createPoint(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['code', 'name', 'address', 'trackNumber', 'invoiceSeries', 'receiptSeries']); const data = masterData(body, true, true);
    const invoice = series(body.invoiceSeries, 'INVOICE'); const receipt = series(body.receiptSeries, 'SALES_RECEIPT');
    return this.write(request, PermissionCodes.SERIES_MANAGE, async (tx, actor, production) => {
      const context = await this.branch(tx, id(value), production); this.requireActive(context.company, 'Emisor'); this.requireActive(context.branch, 'Sede');
      const point = await tx.emissionPoint.create({ data: { code: data.code, name: data.name, address: data.address, trackNumber: data.trackNumber,
        companyId: context.company.id, branchId: context.branch.id, counters: { create: [{ documentType: 'INVOICE', series: invoice }, { documentType: 'SALES_RECEIPT', series: receipt }] } }, include: { counters: true } });
      await this.audit(tx, actor, 'emission-point.created', point.id, context.company, Object.keys(body));
      return { id: point.id, companyId: point.companyId, branchId: point.branchId, code: point.code, name: point.name, active: point.active,
        revision: point.masterRevision, series: point.counters.map(counter => ({ id: counter.id, documentType: counter.documentType, series: counter.series, revision: counter.masterRevision })) };
    });
  }
  async updatePoint(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['expectedRevision', 'code', 'name', 'address', 'trackNumber', 'active']); const data = masterData(body, false, true);
    if (!Object.keys(data).length) throw new BadRequestException('No hay cambios para guardar');
    return this.write(request, PermissionCodes.SERIES_MANAGE, async (tx, actor, production) => {
      const context = await this.point(tx, id(value), production); revision(body, context.point.masterRevision);
      if (data.active === true) { this.requireActive(context.company, 'Emisor'); this.requireActive(context.branch, 'Sede'); }
      if (data.active === false) await this.noOpenShifts(tx, { id: context.point.id });
      const point = await tx.emissionPoint.update({ where: { id: context.point.id }, data: { ...data, masterRevision: { increment: 1 } } });
      await this.audit(tx, actor, data.active === false ? 'emission-point.deactivated' : data.active === true ? 'emission-point.reactivated' : 'emission-point.updated', point.id, context.company, Object.keys(data));
      return { id: point.id, companyId: point.companyId, branchId: point.branchId, code: point.code, name: point.name, address: point.address, trackNumber: point.trackNumber, active: point.active, revision: point.masterRevision };
    });
  }
  deactivatePoint(value: string, input: unknown, request: AuthenticatedRequest) { return this.updatePoint(value, { ...object(input, ['expectedRevision']), active: false }, request); }
  async createSeries(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['documentType', 'series']); if (!seriesTypes.includes(body.documentType as StationSeriesType)) throw new BadRequestException('Tipo de serie no admitido');
    const type = body.documentType as StationSeriesType; const label = series(body.series, type);
    return this.write(request, PermissionCodes.SERIES_MANAGE, async (tx, actor, production) => {
      const context = await this.point(tx, id(value), production); this.requireActive(context.company, 'Emisor'); this.requireActive(context.branch, 'Sede'); this.requireActive(context.point, 'Punto');
      const counter = await tx.seriesCounter.create({ data: { companyId: context.company.id, emissionPointId: context.point.id, documentType: type, series: label } });
      await this.audit(tx, actor, 'series.created', counter.id, context.company, ['documentType', 'series']);
      return { id: counter.id, companyId: counter.companyId, emissionPointId: counter.emissionPointId, documentType: counter.documentType, series: counter.series, nextNumber: counter.nextNumber.toString(), active: counter.active, revision: counter.masterRevision };
    });
  }
  async updateSeries(value: string, input: unknown, request: AuthenticatedRequest) {
    const body = object(input, ['expectedRevision', 'series', 'active']);
    if (!Object.hasOwn(body, 'series') && !Object.hasOwn(body, 'active')) throw new BadRequestException('No hay cambios para guardar');
    if (Object.hasOwn(body, 'active')) active(body.active);
    return this.write(request, PermissionCodes.SERIES_MANAGE, async (tx, actor, production) => {
      const context = await this.counter(tx, id(value), production); const current = context.counter; revision(body, current.masterRevision);
      const data: { series?: string; active?: boolean } = {};
      if (Object.hasOwn(body, 'series')) {
        const label = series(body.series, current.documentType);
        if (label !== current.series) {
          if (current.nextNumber !== 1n || await tx.document.count({ where: { seriesCounterId: current.id } }))
            throw new ConflictException('Serie con historial o numeración consumida: no se permite renombrar ni reiniciar correlativos. Cree otra serie.');
          data.series = label;
        }
      }
      if (Object.hasOwn(body, 'active')) data.active = body.active as boolean;
      if (data.active === true) { this.requireActive(context.company, 'Emisor'); this.requireActive(context.branch, 'Sede'); this.requireActive(context.point, 'Punto'); }
      const counter = await tx.seriesCounter.update({ where: { id: current.id }, data: { ...data, masterRevision: { increment: 1 } } });
      await this.audit(tx, actor, data.active === false ? 'series.deactivated' : data.active === true ? 'series.reactivated' : 'series.updated', current.id, context.company, Object.keys(data));
      return { id: counter.id, companyId: counter.companyId, emissionPointId: counter.emissionPointId, documentType: counter.documentType, series: counter.series, nextNumber: counter.nextNumber.toString(), active: counter.active, revision: counter.masterRevision };
    });
  }
  deactivateSeries(value: string, input: unknown, request: AuthenticatedRequest) { return this.updateSeries(value, { ...object(input, ['expectedRevision']), active: false }, request); }
}
