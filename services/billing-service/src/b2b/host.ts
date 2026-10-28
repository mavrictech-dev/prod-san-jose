import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { B2bOwnerDrain } from '@factuez/service-access/dist/b2b-owner-drain';
import { B2bIdentityHttp, B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { createBillingB2bRuntime, type BillingB2bRuntime } from './runtime';
import { createBillingB2bRuntimeApplication } from './runtime-http';
import { validateBillingHostConfig, validateBillingHostCredentials, type BillingHostConfig, type BillingHostCredentials } from './host-config';
import { requireBuiltinBillingHostImplementations, validateBillingHostImplementations, type BillingHostImplementations } from './host-implementations';
import { installBillingHostEnvironment } from './host-environment';
import { BillingStandaloneOwners, type BillingHostOwners } from './host-di';
import { PostgresReportsCorrectionReadAuthority } from './phase8-reports/correction-read-authority';

export function billingHostClients(config: BillingHostConfig, credentials: BillingHostCredentials) {
  const identityHttp = new B2bPrivateHttp(config.identityOrigin, credentials.identityTls);
  const fiscalHttp = new B2bPrivateHttp(config.fiscalOrigin, credentials.fiscalTls);
  return { identityHttp, fiscalHttp, identity: new B2bIdentityHttp(identityHttp) };
}
/** Callable standalone host. Explicit owner injection supports embedding/tests;
 * the default path constructs the genuine Billing classes and pg pools above. */
export async function startBillingB2bHost(input: BillingHostConfig, mounted: BillingHostCredentials,
  suppliedImplementations?: BillingHostImplementations, suppliedOwners?: BillingHostOwners) {
  const config = validateBillingHostConfig(input), credentials = validateBillingHostCredentials(mounted);
  if (suppliedImplementations) validateBillingHostImplementations(suppliedImplementations); // Before any owner connections.
  const restoreEnvironment = installBillingHostEnvironment(config, credentials);
  let implementations: BillingHostImplementations | undefined = suppliedImplementations;
  let owners: BillingHostOwners | undefined, runtime: BillingB2bRuntime | undefined, app: NestExpressApplication | undefined;
  let running = false, closePromise: Promise<void> | undefined;
  try {
    owners = suppliedOwners ?? new BillingStandaloneOwners(config, credentials);
    const owner = owners, clients = billingHostClients(config, credentials);
    implementations ??= requireBuiltinBillingHostImplementations(config,credentials,owner.prisma);
    validateBillingHostImplementations(implementations);
    const adapters = implementations;
    try { await adapters.assertInfrastructure(); } catch { throw Error('BILLING_HOST_AUTHORITY_INFRASTRUCTURE_UNAVAILABLE'); }
    await owner.initializeStorage();
    const ownerDrain = new B2bOwnerDrain({ enabled: true });
    runtime = createBillingB2bRuntime({
      prisma: owner.prisma, printBranding: owner.printBranding, issueDocument: owner.issueDocument, stationAdmin: owner.stationAdmin,
      ...clients, allowedRucs: config.allowedRucs, deploymentId: config.deploymentId, instanceId: config.instanceId,
      tls: credentials.apiTls, peers: config.peers,
      maintenance: { enabled: true, operatorPeers: config.peers.operators, tls: credentials.operatorTls }, ownerDrain,
      establishmentAdmin: implementations.establishmentAdmin, carrierReferenceValidator: implementations.carrierReferenceValidator,
      business: { pool: owner.businessPool, permissions: implementations.businessPermissions },
      batches: { pool: owner.batchesPool, evidence: implementations.batchEvidence, memberIdentity: implementations.batchMemberIdentity, policyAdmin: implementations.batchPolicyAdmin },
      reports: { pool: owner.reportsPool, corrections: { bindings: config.reports.corrections, authority: new PostgresReportsCorrectionReadAuthority(owner.reportsPool, clients.identity) },
        guides: { bindings: config.reports.guides }, guideMetadata: { origin: config.fiscalOrigin, tls: credentials.fiscalTls }, renderers: implementations.reportRenderers },
      privilegedAdmin: implementations.privilegedAdmin,
      requestAuthorities:adapters.requestAuthorities, batchPolicyAdministration:adapters.batchPolicyAdministration,
      infrastructureCheck: async () => { await owner.assertBetaOwners(); await adapters.assertInfrastructure(); },
      legacyLifecycle: {
        // Standalone has exactly the private runtime listener; its ownerDrain owns admission.
        ADMISSION: async () => { if (!running) throw Error('BILLING_HOST_NOT_RUNNING'); },
        PRODUCERS: () => owner.stopProducers(), WORKERS: () => owner.stopWorkers(),
        STORAGE: async () => { await adapters.close(); await owner.closeStorage(); },
      },
    });
    // No listener or consumer is exposed before actual metadata/owner checks succeed.
    await runtime.status.inspect();
    owner.startStatusConsumer();
    app = await createBillingB2bRuntimeApplication(runtime);
    running = true;
    await app.listen(config.api.port, config.api.host);
    await runtime.listenOperator(config.operator.host, config.operator.port);
    const assembled = runtime, application = app;
    const close = () => closePromise ??= (async () => {
      const snapshot = assembled.maintenance.snapshot();
      const request = { deploymentId: config.deploymentId, instance: snapshot.instance,
        runId: snapshot.runId ?? randomUUID(), inventorySha256: snapshot.inventorySha256 ?? createHash('sha256').update(JSON.stringify({ deploymentId: config.deploymentId, instances: [snapshot.instance] })).digest('hex') };
      for (const phase of ['ADMISSION','PRODUCERS','WORKERS','STORAGE'] as const) await assembled.maintenance.advance(phase, request);
      await assembled.maintenance.closeListener(); running = false; restoreEnvironment();
    })();
    return { runtime: assembled, app: application, close };
  } catch (error) {
    // Failed startup never closes storage while an existing producer/worker may still run.
    let stopped = true;
    if (owners) {
      try { await owners.stopProducers(); } catch { stopped = false; }
      try { await owners.stopWorkers(); } catch { stopped = false; }
    }
    if (runtime) runtime.lifecycle.ownerDrain.closeAdmission();
    if (runtime) {
      const result = await runtime.lifecycle.ownerDrain.drain('ALL');
      if (result.state !== 'DRAINED' || result.pending !== 0) stopped = false;
    }
    if (stopped) {
      try { await app?.close(); await runtime?.maintenance.closeListener(); await implementations?.close(); await owners?.closeStorage(); }
      catch { throw Error('BILLING_HOST_STARTUP_CLEANUP_FAILED'); }
      restoreEnvironment();
    }
    if (!stopped) throw Error('BILLING_HOST_STARTUP_WORK_STILL_ACTIVE');
    if (error instanceof Error && error.message === 'BILLING_HOST_AUTHORITY_INFRASTRUCTURE_UNAVAILABLE') throw error;
    throw Error('BILLING_HOST_STARTUP_FAILED');
  }
}
