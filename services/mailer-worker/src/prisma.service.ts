import { mailerDatabaseName, validatedMailerDatabaseUrl } from './mailer-database-identity';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'node:fs';
import { PrismaClient } from './generated/prisma/client';
function connectionString() {
  if (process.env.DATABASE_URL) return validatedMailerDatabaseUrl(process.env.DATABASE_URL);
  const database = mailerDatabaseName();
  if (!process.env.DB_PASSWORD_FILE || !process.env.DB_USER) throw new Error('Conexión de base Mailer no configurada');
  return validatedMailerDatabaseUrl(`postgresql://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim())}@${process.env.DB_HOST ?? 'postgres'}:5432/${database}`);
}
@Injectable() export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() { super({ adapter: new PrismaPg({ connectionString: connectionString(), connectionTimeoutMillis: 5000 }) }); }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
