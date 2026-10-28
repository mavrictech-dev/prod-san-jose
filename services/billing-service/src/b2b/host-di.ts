import { createRequire } from 'node:module';
import { RedisConnection } from 'bullmq';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../infrastructure/prisma.service';
import { IssueDocumentService } from '../application/issue-document.service';
import { StationAdminService } from '../application/station-admin.service';
import { PrintBrandingService } from '../application/print-branding.service';
import { PrintBrandingStore } from '../infrastructure/print-branding-store';
import { OutboxPublisher } from '../infrastructure/outbox.publisher';
import { SunatStatusConsumer } from '../infrastructure/sunat-status.consumer';
import type { BusinessPgPool } from './phase8-business/postgres-store';
import type { ReportsPgPool } from './phase8-reports/types';
import type { BatchSqlPool } from './batch-member-postgres.types';
import type { BillingHostConfig, BillingHostCredentials } from './host-config';
import {billingHostDatabaseOptions} from './host-config';

type Pool = BusinessPgPool & ReportsPgPool & BatchSqlPool;
/** Real owner DI, independent of AppModule/demo seeds/ScheduleModule.
 * Merely creating the legacy publisher never schedules flush()/fiscal dispatch. */
export class BillingStandaloneOwners {
  readonly prisma: PrismaService;
  readonly printBranding: PrintBrandingService;
  readonly issueDocument: IssueDocumentService;
  readonly stationAdmin: StationAdminService;
  readonly businessPool: Pool;
  readonly reportsPool: Pool;
  readonly batchesPool: Pool;
  private publisher?: OutboxPublisher;
  private consumer?: SunatStatusConsumer;
  private initialized = false;
  private producersStopped = false;
  private workersStopped = false;
  private storageClosed = false;
  constructor(private readonly config: BillingHostConfig, credentials: BillingHostCredentials) {
    const { Pool: PgPool } = createRequire(__filename)('pg') as { Pool: new (config: ReturnType<typeof billingHostDatabaseOptions>) => Pool };
    const options=billingHostDatabaseOptions(credentials);
    this.prisma = new PrismaService(options);
    this.printBranding = new PrintBrandingService(this.prisma);
    this.issueDocument = new IssueDocumentService(this.prisma, this.printBranding);
    this.stationAdmin = new StationAdminService(this.prisma);
    this.businessPool = new PgPool(options); this.reportsPool = new PgPool(options); this.batchesPool = new PgPool(options);
  }
  async initializeStorage() {
    if (this.initialized || this.storageClosed) throw Error('BILLING_HOST_STORAGE_NOT_INITIALIZABLE');
    await this.prisma.onModuleInit();
    // PrintBrandingService reports disabled storage internally; the host verifies
    // the real mounted store explicitly instead of advertising branding anyway.
    await new PrintBrandingStore(this.config.printRoot).initialize();
    await this.printBranding.onModuleInit();
    await this.assertBetaOwners(); this.initialized = true;
  }
  async assertBetaOwners() {
    if (this.storageClosed) throw Error('BILLING_HOST_STORAGE_CLOSED');
    const owners = await this.prisma.companySettings.findMany({ where: { ruc: { in: this.config.allowedRucs }, environment: 'BETA', active: true }, select: { ruc: true } });
    if (owners.length !== this.config.allowedRucs.length || this.config.allowedRucs.some(ruc => !owners.some(owner => owner.ruc === ruc))) throw Error('BILLING_HOST_BETA_OWNERS_REQUIRED');
    const connection = await this.reportsPool.connect();
    try { await connection.query('SELECT "grantKey","revision","payload" FROM "B2bReportsCorrectionReadGrant" WHERE false'); }
    finally { connection.release(); }
    await this.assertRedis();
  }
  private async assertRedis() {
    const connection = new RedisConnection({ host: this.config.redis.host, port: this.config.redis.port,
      password: readFileSync(process.env.REDIS_PASSWORD_FILE!, 'utf8').trim(),
      connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: () => null }, { blocking: false });
    connection.on('error', () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.client.then(async client => { if (await client.ping() !== 'PONG') throw Error(); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('BILLING_HOST_REDIS_UNAVAILABLE')), 4000); }),
      ]);
    } catch { throw Error('BILLING_HOST_REDIS_UNAVAILABLE'); }
    finally { if (timer) clearTimeout(timer); await connection.close(true); }
  }
  startStatusConsumer() {
    if (!this.initialized || this.publisher || this.consumer || this.producersStopped || this.workersStopped) throw Error('BILLING_HOST_WORKERS_NOT_STARTABLE');
    this.publisher = new OutboxPublisher(this.prisma);
    this.consumer = new SunatStatusConsumer(this.prisma);
    this.consumer.onApplicationBootstrap();
  }
  async stopProducers() { await this.publisher?.close(); this.producersStopped = true; }
  async stopWorkers() { await this.consumer?.close(); this.workersStopped = true; }
  async closeStorage() {
    if (this.storageClosed) return;
    if (!this.producersStopped || !this.workersStopped) throw Error('BILLING_HOST_WORK_NOT_DRAINED');
    // Both genuine close() promises have completed BEFORE any pool/Prisma close.
    const results = await Promise.allSettled([this.businessPool.end(), this.reportsPool.end(), this.batchesPool.end()]);
    if (results.some(r => r.status === 'rejected')) throw Error('BILLING_HOST_POOL_CLOSE_FAILED');
    await this.prisma.onModuleDestroy(); this.storageClosed = true;
  }
}
export type BillingHostOwners = Pick<BillingStandaloneOwners,
  'prisma' | 'printBranding' | 'issueDocument' | 'stationAdmin' | 'businessPool' | 'reportsPool' | 'batchesPool' |
  'initializeStorage' | 'assertBetaOwners' | 'startStatusConsumer' | 'stopProducers' | 'stopWorkers' | 'closeStorage'>;
