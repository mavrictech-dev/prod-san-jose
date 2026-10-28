import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {b2bPostgresOptions,type B2bPostgresOptions} from '@factuez/service-access/dist/b2b-postgres-options';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'node:fs';
import { PrismaClient } from './generated/prisma/client';
@Injectable()
export class ReceptionPrisma extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() @Inject('B2B_DATABASE_OPTIONS') options?:B2bPostgresOptions) {
    let url = process.env.DATABASE_URL;
    if (options===undefined&&!url) {
      if (!process.env.DB_PASSWORD_FILE || !process.env.DB_NAME || !process.env.DB_USER) throw new Error('Falta configuración de la BD de recepción');
      const password = readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim();
      url = `postgresql://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(password)}@${process.env.DB_HOST ?? 'postgres'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`;
    }
    super({ adapter: new PrismaPg(options===undefined?{ connectionString: url, connectionTimeoutMillis: 5000 }:b2bPostgresOptions(options)) });
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
