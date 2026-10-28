import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma.service";

/** Datos mínimos para recorrer el flujo local. Sólo se activa explícitamente. */
@Injectable()
export class DemoBootstrapService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    if (process.env.FACTUEZ_DEMO_SEED !== "true") return;
    if (process.env.SUNAT_ENVIRONMENT === "PRODUCTION") {
      throw new Error(
        "FACTUEZ_DEMO_SEED no puede ejecutarse en entorno PRODUCTIVO",
      );
    }

    const company = await this.prisma.companySettings.upsert({
      where: { ruc: "20450819230" },
      create: {
        ruc: "20450819230",
        legalName: "GRIFO SAN JOSE S.R.L.",
        tradeName: "Estaciones San José",
        companyType: "Sociedad Comercial de Responsabilidad Limitada",
        economicActivities: [
          "Venta al por mayor y menor de combustibles gaseosos, líquidos y derivados",
        ],
        taxAddress: "Dirección fiscal por configurar en la instalación",
        ubigeo: "200101",
        department: "Piura",
        province: "Piura",
        district: "Piura",
        stationManager: "Administrador de estación",
        contactEmails: [],
        environment: "BETA",
        setupCompletedAt: new Date(),
      },
      update: {},
    });

    const branch = await this.prisma.branch.upsert({
      where: { code: "CENTRAL" },
      create: {
        id: "10000000-0000-4000-8000-000000000001",
        companyId: company.id,
        code: "CENTRAL",
        name: "Sede principal",
      },
      update: {},
    });
    await this.prisma.emissionPoint.updateMany({
      where: { companyId: company.id, branchId: null },
      data: { branchId: branch.id },
    });
    const point = await this.prisma.emissionPoint.upsert({
      where: { code: "PISTA-01" },
      create: {
        companyId: company.id,
        branchId: branch.id,
        code: "PISTA-01",
        name: "Pista 1",
        trackNumber: 1,
        active: true,
      },
      update: {},
    });

    for (const counter of [
      { documentType: "SALES_RECEIPT" as const, series: "B001" },
      { documentType: "INVOICE" as const, series: "F001" },
    ]) {
      await this.prisma.seriesCounter.upsert({
        where: {
          companyId_documentType_series: {
            companyId: company.id,
            documentType: counter.documentType,
            series: counter.series,
          },
        },
        create: {
          companyId: company.id,
          emissionPointId: point.id,
          ...counter,
          nextNumber: 1n,
          active: true,
        },
        update: {},
      });
    }

    const products = [
      {
        sku: "GASOHOL-REGULAR",
        description: "Gasohol Regular",
        unitCode: "GLL",
        price: "16.50",
      },
      {
        sku: "GASOHOL-PREMIUM",
        description: "Gasohol Premium",
        unitCode: "GLL",
        price: "17.50",
      },
      {
        sku: "DIESEL-B5",
        description: "Diesel B5",
        unitCode: "GLL",
        price: "15.90",
      },
      { sku: "GLP", description: "GLP", unitCode: "GLL", price: "7.80" },
      { sku: "GNV", description: "GNV", unitCode: "M3", price: "1.75" },
    ];
    for (const product of products) {
      await this.prisma.fuelProduct.upsert({
        where: { sku: product.sku },
        create: {
          sku: product.sku,
          description: product.description,
          unitCode: product.unitCode,
          category: "COMBUSTIBLE",
          taxAffectationCode: "10",
          defaultUnitPrice: product.price,
        },
        update: {
          description: product.description,
          unitCode: product.unitCode,
          defaultUnitPrice: product.price,
          active: true,
        },
      });
    }
  }
}
