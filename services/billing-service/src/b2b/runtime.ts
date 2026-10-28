import { Module, type DynamicModule } from '@nestjs/common';
import { B2bOwnerRuntimeStatus, B2bOwnerRuntimeStatusModule } from '@factuez/service-access/dist/b2b-runtime-status';
import { B2bMaintenanceNode } from '@factuez/service-access/dist/b2b-maintenance-node';
import { PrismaOwnerJournal } from '@factuez/service-access/dist/integration-owner-changes';
import { Phase8AdminOwnerModule } from '@factuez/service-access/dist/b2b-phase8-admin-http';
import { validB2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { B2bContextService, PrismaB2bContextRepository } from './context';
import { B2bContextModule } from './http';
import { B2bBillingReads, PrismaB2bReadRepository } from './read';
import { B2bBillingReadModule } from './read-http';
import { B2bBillingExtraction } from './extraction';
import { PrismaBillingCapture } from '../integration/capture-repository';
import { B2bDrafts } from './drafts';
import { PostgresB2bDraftStore } from './draft-store';
import { B2bDraftOwnerModule } from './draft-http';
import { b2bDraftIssuer, B2B_ISSUANCE_PROFILE } from './issuance';
import { B2bCommercial } from './commercial';
import { PostgresB2bCommercialStore } from './commercial-store';
import { B2bCommercialOwnerModule } from './commercial-http';
import { B2bCorrectionCatalogue, PrismaB2bCorrectionPairRepository } from './correction-catalogue';
import { B2bCorrectionCatalogueModule } from './correction-catalogue-http';
import { BillingB2bCorrectionAuthorization } from './correction-authorization';
import { createBillingCorrectionProducer } from './correction-producer-assembly';
import { BillingCorrectionProducerModule } from './correction-producer-http';
import { BillingCorrectionEvidenceAuthority, PrismaCorrectionEvidenceScope } from './correction-evidence-authority';
import { BillingCorrectionEvidenceModule } from './correction-evidence-http';
import { createBillingGuideDrafts, createBillingGuideEstablishments, createBillingGuideGoods, createBillingCataloguedGuidePreparation } from './guide-assembly';
import { BillingGuideModule } from './guide-http';
import { BillingGuideCatalogueModule, PrismaGuideDraftCatalogue } from './guide-catalogue';
import { BillingGuideEstablishmentModule } from './guide-establishment-http';
import { BillingGuidePreparationModule } from './guide-preparation-http';
import { BillingB2bGuideIssueAuthorization } from './guide-issue-authorization';
import { createAuthorizedCandidateGuideIssueProducer } from './guide-issue-assembly';
import { BillingGuideIssueModule } from './guide-issue-http';
import { BillingGuideIssueCatalogue, BillingGuideIssueCatalogueModule } from './guide-issue-catalogue';
import { BillingB2bCarrierGuideAuthority } from './carrier-guide-authority';
import { createCarrierGuideOwner } from './carrier-guide-assembly';
import { BillingCarrierGuideModule } from './carrier-guide-http';
import { BillingBatchPolicyModule } from './batch-policy-http';
import { createBillingBatchOperations, BillingBatchOperationsModule } from './batch-member-http';
import { BillingBatchCreditHistory } from './batch-credit-history';
import { BatchCreditHistoryVersionBridge } from './batch-credit-history-version-bridge';
import { BillingCreditHistoryModule } from './batch-credit-history-http';
import { B2bPhase8Business } from './phase8-business/engine';
import { PostgresBusinessStore } from './phase8-business/postgres-store';
import { B2bPhase8BusinessOwnerModule } from './phase8-business-http';
import { B2bReports } from './phase8-reports/engine';
import { PostgresReportsStore } from './phase8-reports/postgres-store';
import { PostgresBillingReportSources } from './phase8-reports/source-store';
import { HttpReportsGuideMetadata } from './phase8-reports/guide-metadata-http';
import { BillingOwnerReportSources } from './phase8-reports/owner-sources';
import { B2bPhase8ReportsOwnerModule } from './phase8-reports-http';
import { B2bPhase8BillingAdmin, BillingPhase8AdminBindingOwner } from './phase8-admin';
import { BillingRuntimeLifecycle } from './runtime-lifecycle';
import { checkBillingRuntimeStorage } from './runtime-storage';
import { requiredMethod, runtimePeers, runtimeTls, type BillingB2bRuntimeDependencies } from './runtime-dependencies';
import { BillingRuntimeHttpModule } from './runtime-http';

export type { BillingB2bRuntimeDependencies, BillingRuntimeTls } from './runtime-dependencies';
@Module({})
export class BillingB2bRuntimeModule {}

/** Explicit owner assembly. Construction is inert: no env, listeners, DB mutations,
 * timers or fiscal dispatch. Required legacy hooks prevent false full-main coverage. */
export function createBillingB2bRuntime(deps: BillingB2bRuntimeDependencies) {
  if (!deps) throw Error('BILLING_RUNTIME_DEPENDENCIES_REQUIRED');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (!uuid.test(deps.deploymentId) || !uuid.test(deps.instanceId)) throw Error('BILLING_RUNTIME_IDENTITY_REQUIRED');
  const required: [unknown, string, string][] = [
    ...['install','pauseCommands','closeAdmission','drain','snapshot'].map(method => [deps.ownerDrain, method, 'ownerDrain'] as [unknown,string,string]),
    [deps.prisma, '$transaction', 'prisma'], [deps.prisma, '$queryRawUnsafe', 'prisma'],
    [deps.issueDocument, 'executeWithinTransaction', 'issueDocument'],
    ...['catalog','createIssuer','updateIssuer','createBranch','updateBranch','createPoint','updatePoint','createSeries','updateSeries'].map(method => [deps.stationAdmin, method, 'stationAdmin'] as [unknown,string,string]),
    ...['settings','save','preview'].map(method => [deps.printBranding, method, 'printBranding'] as [unknown,string,string]), [deps.printBranding, 'snapshotForB2b', 'printBranding'],
    [deps.identity, 'authenticate', 'identity'], [deps.identityHttp, 'post', 'identityHttp'], [deps.fiscalHttp, 'post', 'fiscalHttp'],
    [deps.establishmentAdmin, 'verify', 'establishmentAdmin'], [deps.carrierReferenceValidator, 'verify', 'carrierReferenceValidator'],
    [deps.business?.pool, 'connect', 'business.pool'], [deps.business?.pool, 'end', 'business.pool'],
    [deps.business?.permissions, 'authorizeCurrent', 'business.permissions'], [deps.reports?.pool, 'connect', 'reports.pool'],
    [deps.reports?.corrections?.authority, 'current', 'reports.corrections.authority'],
    [deps.batches?.pool, 'connect', 'batches.pool'], [deps.batches?.evidence, 'verifySignedVersion', 'batches.evidence'],
    [deps.batches?.memberIdentity, 'current', 'batches.memberIdentity'], [deps.batches?.policyAdmin, 'authorizeStepUp', 'batches.policyAdmin'],
    [deps.privilegedAdmin?.authority, 'authorize', 'privilegedAdmin.authority'],
    [deps.privilegedAdmin?.liveIdentity, 'current', 'privilegedAdmin.liveIdentity'],
    ...(['ADMISSION', 'PRODUCERS', 'WORKERS', 'STORAGE'] as const).map(phase => [deps.legacyLifecycle, phase, 'legacyLifecycle'] as [unknown, string, string]),
  ];
  for (const [value, method, name] of required) requiredMethod(value, method, name);
  if (!Array.isArray(deps.allowedRucs) || !deps.allowedRucs.length || deps.allowedRucs.length > 20 ||
      new Set(deps.allowedRucs).size !== deps.allowedRucs.length || deps.allowedRucs.some(r => !/^\d{11}$/.test(r)))
    throw Error('BILLING_RUNTIME_ALLOWLIST_REQUIRED');
  const allowedRucs = Object.freeze([...deps.allowedRucs]);
  const corrections = deps.reports.corrections.bindings, guidesConfig = deps.reports.guides?.bindings;
  if (!Array.isArray(corrections) || !corrections.length || !corrections.every(validB2bCorrectionBinding) ||
      !Array.isArray(guidesConfig) || !guidesConfig.length || !guidesConfig.every(validB2bGuideIssueBinding) ||
      corrections.some(b => !allowedRucs.includes(b.reference.issuerRuc)) || guidesConfig.some(b => !allowedRucs.includes(b.draft.anchor.issuerRuc)))
    throw Error('BILLING_RUNTIME_REPORT_SOURCE_MAPS_REQUIRED');
  const callers = runtimePeers(deps.peers?.callers, 'callers'), registrar = runtimePeers(deps.peers?.registrar, 'registrar');
  const administrators = runtimePeers(deps.peers?.administrators, 'administrators'), statusPeers = runtimePeers(deps.peers?.status, 'status');
  const evidencePeers = runtimePeers(deps.peers?.evidence, 'evidence');
  if (typeof deps.maintenance?.enabled !== 'boolean') throw Error('BILLING_RUNTIME_MAINTENANCE_CONFIG_REQUIRED');
  const operatorPeers = runtimePeers(deps.maintenance.operatorPeers, 'operators');
  const tls = runtimeTls(deps.tls), operatorTls = runtimeTls(deps.maintenance.tls);
  if (operatorPeers.some(p => [...callers, ...registrar, ...administrators, ...statusPeers, ...evidencePeers].includes(p)))
    throw Error('BILLING_RUNTIME_SEPARATE_OPERATOR_IDENTITY_REQUIRED');
  if (!deps.reports.guideMetadata || typeof deps.reports.guideMetadata.origin !== 'string') throw Error('BILLING_RUNTIME_REPORT_METADATA_REQUIRED');
  const metadata = new HttpReportsGuideMetadata(deps.reports.guideMetadata.origin, runtimeTls(deps.reports.guideMetadata.tls), deps.identity);
  const db = deps.prisma, identity = deps.identity;
  const context = new PrismaB2bContextRepository(db);
  const repository = new PrismaB2bReadRepository(db);
  const reads = new B2bBillingReads(repository, identity, deps.printBranding,
    new B2bBillingExtraction(repository, new PrismaBillingCapture(db, true), new PrismaOwnerJournal(db, 'BILLING'), identity));
  const issuer = b2bDraftIssuer(deps.issueDocument, { profile: B2B_ISSUANCE_PROFILE, allowedIssuerRucs: allowedRucs });
  const drafts = new B2bDrafts(new PostgresB2bDraftStore(db, issuer), identity, context);
  const commercial = new B2bCommercial(new PostgresB2bCommercialStore(db, issuer), identity, context, true);
  const correctionAuthorization = new BillingB2bCorrectionAuthorization(identity, deps.identityHttp);
  const correctionFactory = (token: string, kind: 'SERVICE' | 'USER', binding: Parameters<typeof createBillingCorrectionProducer>[5]) =>
    createBillingCorrectionProducer(db, correctionAuthorization, deps.fiscalHttp, token, kind, binding, allowedRucs);
  const guides = createBillingGuideDrafts(db, identity, deps.identityHttp);
  const establishments = createBillingGuideEstablishments(db, deps.establishmentAdmin);
  const goods = createBillingGuideGoods(db, deps.establishmentAdmin);
  const preparation = createBillingCataloguedGuidePreparation(db, guides, establishments, goods);
  const guideAuthority = new BillingB2bGuideIssueAuthorization(identity, deps.identityHttp);
  const guideProducer = createAuthorizedCandidateGuideIssueProducer({ database: db, identity, identityHttp: deps.identityHttp, allowedRucs });
  const carrierAuthority = new BillingB2bCarrierGuideAuthority(guideAuthority);
  const carrier = createCarrierGuideOwner({ database: db, authority: carrierAuthority, referenceValidator: deps.carrierReferenceValidator, allowedRucs });
  const batchCore = createBillingBatchOperations({ ...deps.batches, identity });
  // Internal candidate only: uses the real authorized journal and exact owner
  // versions. It installs no route and does not claim signed/CDR completeness.
  const creditHistory = new BatchCreditHistoryVersionBridge(
    new BillingBatchCreditHistory(db, identity, deps.reports.corrections.authority, corrections), batchCore.owner);
  const sessions=deps.requestAuthorities;
  if(sessions&&(sessions.permissions.businessPermissions!==deps.business.permissions||sessions.permissions.establishmentAdmin!==deps.establishmentAdmin||sessions.batches.memberIdentity!==deps.batches.memberIdentity))throw Error('BILLING_RUNTIME_AUTHORITY_SESSION_MISMATCH');
  const batches=sessions?{...batchCore,operations:sessions.batches.wrap(batchCore.operations)}:batchCore;
  const businessStore = new PostgresBusinessStore(deps.business.pool);
  const businessCore = new B2bPhase8Business(businessStore, identity, context, deps.business.permissions);
  const business=sessions?sessions.permissions.wrapBusinessExecutor(businessCore):businessCore;
  const establishmentHttp=sessions?sessions.permissions.configuredEstablishments(establishments,sessions.masterBindings):establishments;
  const goodsHttp=sessions?sessions.permissions.configuredEstablishments(goods,sessions.masterBindings):goods;
  const sources = new BillingOwnerReportSources(new PostgresBillingReportSources(deps.reports.pool), {
    corrections: { bindings: corrections, authority: deps.reports.corrections.authority },
    guides: { bindings: guidesConfig, authority09: guideAuthority, authority31: carrierAuthority, metadata }, salesNotes: true,
  });
  const reports = new B2bReports(new PostgresReportsStore(deps.reports.pool), identity, reads,
    { enabled: true, sources, renderers: deps.reports.renderers });
  const admin = new B2bPhase8BillingAdmin({ identity, ...deps.privilegedAdmin, bindingOwner: new BillingPhase8AdminBindingOwner(db), enabled: true },
    { masters: deps.stationAdmin, branding: deps.printBranding });
  if (deps.ownerDrain.snapshot().state !== 'OPEN' || deps.ownerDrain.snapshot().active !== 0) throw Error('BILLING_RUNTIME_FRESH_OWNER_DRAIN_REQUIRED');
  const lifecycle = new BillingRuntimeLifecycle(deps.ownerDrain);
  // Each capability is attached only after its actual owner and HTTP module have been constructed.
  const installed: { capability: string; module: DynamicModule }[] = [
    { capability: 'READ', module: B2bBillingReadModule.isolated(reads, callers) },
    { capability: 'DRAFTS', module: B2bDraftOwnerModule.isolated(drafts, callers) },
    { capability: 'COMMERCIAL', module: B2bCommercialOwnerModule.isolated(commercial, callers) },
    { capability: 'CORRECTIONS', module: BillingCorrectionProducerModule.isolated(correctionFactory, callers) },
    { capability: 'GUIDES', module: BillingGuideModule.isolated(guides, callers) },
    { capability: 'CARRIER', module: BillingCarrierGuideModule.isolated(carrier, callers) },
    { capability: 'BATCHES', module: BillingBatchOperationsModule.isolated(batches.operations, callers) },
    { capability: 'BUSINESS', module: B2bPhase8BusinessOwnerModule.isolated(business, callers) },
    { capability: 'REPORTS', module: B2bPhase8ReportsOwnerModule.isolated(reports, callers) },
    { capability: 'PRIVILEGED_ADMIN', module: Phase8AdminOwnerModule.isolated(admin,
      ['MASTERS_READ', 'ISSUER_CREATE', 'ISSUER_UPDATE', 'BRANCH_CREATE', 'BRANCH_UPDATE', 'POINT_CREATE', 'POINT_UPDATE', 'SERIES_CREATE', 'SERIES_UPDATE', 'PRINT_READ', 'PRINT_SAVE', 'PRINT_PREVIEW'], administrators) },
  ];
  const status = new B2bOwnerRuntimeStatus('billing', deps.deploymentId, installed.map(v => v.capability), async () => {
    if (!lifecycle.snapshot().storageOpen || !lifecycle.snapshot().admissionOpen) throw Error('BILLING_RUNTIME_QUIESCING');
    await deps.infrastructureCheck?.();
    await checkBillingRuntimeStorage(db, { business: deps.business.pool, reports: deps.reports.pool, batches: deps.batches.pool });
    if (!lifecycle.snapshot().storageOpen || !lifecycle.snapshot().admissionOpen) throw Error('BILLING_RUNTIME_QUIESCING');
  });
  const maintenance = new B2bMaintenanceNode({ enabled: deps.maintenance.enabled, deploymentId: deps.deploymentId,
    instance: { service: 'BILLING', instanceId: deps.instanceId, bootId: status.bootId },
    hooks: lifecycle.hooks(deps.legacyLifecycle, () => businessStore.close()) });
  const module: DynamicModule = { module: BillingB2bRuntimeModule, imports: [
    ...installed.map(v => v.module),
    ...(deps.batchPolicyAdministration ? [BillingBatchPolicyModule.isolated(deps.batchPolicyAdministration,batchCore.owner,administrators)] : []),
    BillingCreditHistoryModule.isolated(creditHistory,callers),
    B2bContextModule.isolated(new B2bContextService(context, identity), { context: callers, registrar }),
    B2bCorrectionCatalogueModule.isolated(new B2bCorrectionCatalogue(new PrismaB2bCorrectionPairRepository(db)), registrar),
    BillingCorrectionEvidenceModule.isolated(new BillingCorrectionEvidenceAuthority(correctionAuthorization, new PrismaCorrectionEvidenceScope(db)), evidencePeers),
    BillingGuideCatalogueModule.isolated(new PrismaGuideDraftCatalogue(db), registrar),
    BillingGuideIssueCatalogueModule.isolated(new BillingGuideIssueCatalogue(db), registrar),
    BillingGuidePreparationModule.isolated(preparation, callers), BillingGuideIssueModule.isolated(guideProducer, callers),
    BillingGuideEstablishmentModule.isolated(establishmentHttp, administrators),
    BillingRuntimeHttpModule.isolated(lifecycle, goodsHttp, administrators),
    B2bOwnerRuntimeStatusModule.isolated(status, statusPeers),
  ] };
  return {
    module, status, maintenance, lifecycle,
    cores: { context, reads, drafts, commercial, correctionFactory, guides, establishments, goods, preparation, guideProducer, carrier, batches, creditHistory, business, reports, admin },
    transport: { tls, peers: [...new Set([...callers, ...registrar, ...administrators, ...statusPeers, ...evidencePeers])] },
    listenOperator: (host: '127.0.0.1' | '0.0.0.0', port: number) => maintenance.listen({ host, port, tls: operatorTls, operatorPeers }),
  };
}
export type BillingB2bRuntime = ReturnType<typeof createBillingB2bRuntime>;

