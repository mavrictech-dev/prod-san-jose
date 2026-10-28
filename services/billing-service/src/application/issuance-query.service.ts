import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { allowsResource, type AccessScope } from "@factuez/contracts";
import type { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../infrastructure/prisma.service";

@Injectable()
export class IssuanceQueryService {
  constructor(private readonly prisma: PrismaService) {}

  pointWhere(
    scope: AccessScope,
    branchId?: string,
    activeOnly = true,
  ): Prisma.EmissionPointWhereInput {
    if (branchId && !/^[0-9a-f-]{36}$/i.test(branchId))
      throw new BadRequestException("Sede inválida");
    if (branchId && !allowsResource(scope, branchId))
      throw new ForbiddenException("Sede no autorizada");
    return {
      ...(activeOnly ? { active: true, branch: { active: true }, company: { active: true, environment: process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true' ? { in: ['BETA', 'PRODUCTION'] } : 'BETA' } } : {}),
      ...(scope.kind === "ASSIGNED"
        ? {
            id: { in: scope.emissionPointIds },
            branchId: { in: scope.branchIds },
          }
        : {}),
      ...(branchId ? { branchId } : {}),
    };
  }

  async catalog(scope: AccessScope) {
    const environment = process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true'
      ? { in: ['BETA', 'PRODUCTION'] as ('BETA' | 'PRODUCTION')[] } : 'BETA' as const;
    const [companies, branches, points, products] = await Promise.all([
      this.prisma.companySettings.findMany({
        where:
          { active: true, environment, ...(scope.kind === "GLOBAL" ? {} : { branches: { some: { id: { in: scope.branchIds } } } }) },
        select: { id: true, ruc: true, legalName: true, environment: true },
        orderBy: { legalName: "asc" },
      }),
      this.prisma.branch.findMany({
        where: {
          active: true,
          company: { active: true, environment },
          ...(scope.kind === "ASSIGNED" ? { id: { in: scope.branchIds } } : {}),
        },
        orderBy: { code: "asc" },
      }),
      this.prisma.emissionPoint.findMany({
        where: this.pointWhere(scope),
        include: {
          counters: {
            where: {
              active: true,
              ...(scope.kind === "ASSIGNED"
                ? { id: { in: scope.series } }
                : {}),
            },
          },
        },
        orderBy: { code: "asc" },
      }),
      this.prisma.fuelProduct.findMany({
        where: { active: true },
        orderBy: { description: "asc" },
      }),
    ]);
    // Misma identidad de laboratorio que GRE QA; el nombre no clasifica datos.
    const companySources = new Map(
      companies.map((company) => [
        company.id,
        /^00\d{9}$/.test(company.ruc) ? "SYNTHETIC" as const : "BUSINESS" as const,
      ]),
    );
    return {
      companies: companies.map((company) => ({
        ...company,
        source: companySources.get(company.id)!,
      })),
      catalogPolicy: {
        sourceRule: "RUC00",
        defaultSource: "BUSINESS",
        historyIncludesAllSources: true,
      },
      capabilities: {
        fiscalTransmission: false,
        productionInvoiceAdmission: process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true',
        demoData: process.env.FACTUEZ_DEMO_SEED === "true",
      },
      branches: branches.map((branch) => ({
        ...branch,
        source: companySources.get(branch.companyId),
      })),
      emissionPoints: points.map((point) => ({
        id: point.id,
        code: point.code,
        name: point.name,
        branchId: point.branchId,
        companyId: point.companyId,
        source: companySources.get(point.companyId),
        trackNumber: point.trackNumber,
        series: point.counters.map((counter) => ({
          id: counter.id,
          documentType: counter.documentType,
          series: counter.series,
        })),
      })),
      products: products.map((product) => ({
        id: product.id,
        sku: product.sku,
        description: product.description,
        unitCode: product.unitCode,
        taxAffectationCode: product.taxAffectationCode,
        defaultUnitPrice: product.defaultUnitPrice?.toString() ?? null,
      })),
    };
  }

  private async where(
    scope: AccessScope,
    branchId?: string,
    companyId?: string,
    dataSource?: string,
  ): Promise<Prisma.DocumentWhereInput> {
    if (dataSource !== undefined && !['BUSINESS', 'SYNTHETIC', 'ALL'].includes(dataSource))
      throw new BadRequestException('Fuente de datos inválida');
    if (
      companyId &&
      (!/^[1-9]\d{0,9}$/.test(companyId) ||
        !Number.isSafeInteger(Number(companyId)))
    )
      throw new BadRequestException("Emisor inválido");
    if (companyId && (scope.kind === "ASSIGNED" || branchId)) {
      const branch = await this.prisma.branch.findFirst({
        where: {
          companyId: Number(companyId),
          ...(branchId
            ? { id: branchId }
            : { id: { in: scope.kind === "ASSIGNED" ? scope.branchIds : [] } }),
        },
      });
      if (!branch) throw new ForbiddenException("Emisor o sede no autorizados");
    }
    return {
      ...(companyId ? { companyId: Number(companyId) } : {}),
      ...(dataSource === 'BUSINESS' ? { company: { ruc: { not: { startsWith: '00' } } } }
        : dataSource === 'SYNTHETIC' ? { company: { ruc: { startsWith: '00' } } } : {}),
      emissionPoint: this.pointWhere(scope, branchId, false),
      ...(scope.kind === "ASSIGNED"
        ? { seriesCounterId: { in: scope.series } }
        : {}),
    };
  }

  async recentDocuments(
    scope: AccessScope,
    branchId?: string,
    page = 1,
    query = "",
    companyId?: string,
    dataSource?: string,
  ) {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      query.length > 100
    )
      throw new BadRequestException("Paginación o búsqueda inválida");
    const where: Prisma.DocumentWhereInput = {
      ...(await this.where(scope, branchId, companyId, dataSource)),
      ...(query
        ? {
            OR: [
              { fullNumber: { contains: query, mode: "insensitive" } },
              { customerLegalName: { contains: query, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [total, documents] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * 20,
        take: 20,
        include: {
          company: true,
          emissionPoint: { include: { branch: true } },
        },
      }),
    ]);
    return {
      page,
      pageSize: 20,
      ...(dataSource !== undefined ? { dataSource } : {}),
      total,
      items: documents.map((document) => ({
        id: document.id,
        companyId: document.companyId,
        issuerRuc:
          (
            document.immutableSnapshot as {
              issuer?: { identityNumber?: string };
            }
          ).issuer?.identityNumber ?? document.company.ruc,
        fullNumber: document.fullNumber,
        documentType: document.type,
        customerLegalName: document.customerLegalName,
        payableAmount: document.payableAmount.toString(),
        currencyCode: document.currencyCode,
        sunatStatus: document.sunatStatus,
        issueDate: document.issueDate.toISOString(),
        branchName: document.emissionPoint.branch?.name ?? "Sin sede",
        sunatResponseDescription: document.sunatResponseDescription,
      })),
    };
  }

  async dashboard(scope: AccessScope, branchId?: string, companyId?: string, dataSource?: string) {
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const start = new Date(localDate + "T00:00:00-05:00");
    const end = new Date(start.getTime() + 86400000);
    const where: Prisma.DocumentWhereInput = {
      ...(await this.where(scope, branchId, companyId, dataSource)),
      issueDate: { gte: start, lt: end },
      currencyCode: "PEN",
    };
    // Separar la inferencia genérica de groupBy del contexto de $transaction.
    const stateQuery = this.prisma.document.groupBy({
      by: ["sunatStatus"],
      orderBy: { sunatStatus: "asc" },
      where,
      _count: { _all: true },
    });
    const typeQuery = this.prisma.document.groupBy({
      by: ["type"],
      orderBy: { type: "asc" },
      where,
      _count: { _all: true },
      _sum: { payableAmount: true },
    });
    const pointQuery = this.prisma.document.groupBy({
      by: ["emissionPointId"],
      orderBy: { emissionPointId: "asc" },
      where,
      _count: { _all: true },
      _sum: { payableAmount: true },
    });
    const [totals, states, types, branchTotals] =
      await this.prisma.$transaction([
        this.prisma.document.aggregate({
          where,
          _count: { _all: true },
          _sum: { payableAmount: true, igvAmount: true },
        }),
        stateQuery,
        typeQuery,
        pointQuery,
      ]);
    return {
      date: localDate,
      ...(dataSource !== undefined ? { dataSource } : {}),
      currencyCode: "PEN",
      updatedAt: new Date().toISOString(),
      count: totals._count._all,
      amount: totals._sum.payableAmount?.toString() ?? "0",
      igv: totals._sum.igvAmount?.toString() ?? "0",
      states: states.map((entry) => ({
        status: entry.sunatStatus,
        count: entry._count._all,
      })),
      types: types.map((entry) => ({
        type: entry.type,
        count: entry._count._all,
        amount: entry._sum.payableAmount?.toString() ?? "0",
      })),
      points: branchTotals.map((entry) => ({
        pointId: entry.emissionPointId,
        count: entry._count._all,
        amount: entry._sum.payableAmount?.toString() ?? "0",
      })),
    };
  }

  async documentDetail(scope: AccessScope, documentId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        documentId,
      )
    )
      throw new BadRequestException("Documento inválido");
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ...(await this.where(scope)) },
      select: {
        id: true,
        companyId: true,
        fullNumber: true,
        sunatStatus: true,
        sunatResponseDescription: true,
        immutableSnapshot: true,
        emissionPoint: { select: { branchId: true } },
      },
    });
    if (!document)
      throw new NotFoundException("Documento no disponible en su alcance");
    const { emissionPoint, ...detail } = document;
    return {
      ...detail,
      printContext: {
        companyId: document.companyId,
        branchId:
          emissionPoint?.branchId ??
          (document.immutableSnapshot as { branchId?: string } | null)?.branchId ??
          null,
      },
      fiscalTransmission: false,
    };
  }
}
