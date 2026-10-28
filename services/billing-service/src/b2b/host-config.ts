import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { isAbsolute, parse, resolve } from 'node:path';
import { B2bRuntimeFiles } from '@factuez/service-access/dist/b2b-runtime-files';
import {b2bPostgresOptions} from '@factuez/service-access/dist/b2b-postgres-options';
import { fiscalRuc } from '@factuez/sunat-core/dist/fiscal-note';
import { validB2bCorrectionBinding, type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import { validB2bGuideIssueBinding, type B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import { adminDigest } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { batchPolicyBoundaries, type BatchPolicyBoundary } from './batch-policy-administration';
import { validB2bBinding, type B2bBinding } from '@factuez/contracts/b2b-security';
import { runtimePeers, type BillingRuntimeTls } from './runtime-dependencies';

export interface BillingHostConfig {
  schemaVersion: 'factuez.b2b.billing-host.v1'; enabled: true; environment: 'BETA';
  deploymentId: string; instanceId: string;
  api: { host: '127.0.0.1' | '0.0.0.0'; port: number };
  operator: { host: '127.0.0.1' | '0.0.0.0'; port: number };
  identityOrigin: string; fiscalOrigin: string; allowedRucs: string[];
  builtin?: { identityServerSha256: string; fiscalServerSha256: string; masterBindings: B2bBinding[]; batchPolicyBindings: BatchPolicyBoundary[] };
  peers: { callers: string[]; registrar: string[]; administrators: string[]; status: string[]; evidence: string[]; operators: string[] };
  reports: { corrections: B2bCorrectionBinding[]; guides: B2bGuideIssueBinding[] };
  redis: { host: string; port: number };
  printRoot: string;
  /** No schedule is installed for the legacy fiscal publisher in this candidate host. */
  legacyOutboxDispatch: false;
}
export interface BillingHostCredentials {
  databaseUrl: string; databaseCa:Buffer; redisPassword: Buffer; redisPasswordFile: string;
  authorityTls?: BillingRuntimeTls;
  apiTls: BillingRuntimeTls; operatorTls: BillingRuntimeTls; identityTls: BillingRuntimeTls; fiscalTls: BillingRuntimeTls;
}
const invalid = () => Error('BILLING_HOST_EXPLICIT_BETA_CONFIGURATION_REQUIRED');
function exact(v: unknown, keys: readonly string[]): asserts v is Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype ||
      Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k)) ||
      Object.values(Object.getOwnPropertyDescriptors(v)).some(d => !d.enumerable || !('value' in d))) throw invalid();
}
const uuid = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
function origin(s: unknown) {
  if (typeof s !== 'string' || s.length > 2048 || /[\s\\?#]/.test(s)) throw invalid();
  const u = new URL(s); if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/') throw invalid();
}
export function validateBillingHostConfig(input: unknown): BillingHostConfig {
  try {
    exact(input, ['schemaVersion','enabled','environment','deploymentId','instanceId','api','operator','identityOrigin','fiscalOrigin','allowedRucs','peers','reports','redis','printRoot','legacyOutboxDispatch',...(input && typeof input === 'object' && Object.hasOwn(input,'builtin') ? ['builtin'] : [])]);
    if (input.schemaVersion !== 'factuez.b2b.billing-host.v1' || input.enabled !== true || input.environment !== 'BETA' || !uuid(input.deploymentId) || !uuid(input.instanceId) || input.legacyOutboxDispatch !== false) throw invalid();
    for (const listener of [input.api, input.operator]) {
      exact(listener, ['host','port']);
      if (!['127.0.0.1','0.0.0.0'].includes(listener.host) || !Number.isInteger(listener.port) || listener.port < 0 || listener.port > 65535) throw invalid();
    }
    if (input.api.port !== 0 && input.api.port === input.operator.port) throw invalid();
    origin(input.identityOrigin); origin(input.fiscalOrigin);
    if (!Array.isArray(input.allowedRucs) || !input.allowedRucs.length || input.allowedRucs.length > 20 || new Set(input.allowedRucs).size !== input.allowedRucs.length) throw invalid();
    for (const r of input.allowedRucs) fiscalRuc(r, 'allowlist');
    exact(input.peers, ['callers','registrar','administrators','status','evidence','operators']);
    for (const [role, values] of Object.entries(input.peers)) runtimePeers(values as string[], role);
    const businessPeers = ['callers','registrar','administrators','status','evidence'].flatMap(k => input.peers[k]);
    if (input.peers.operators.some((p: string) => businessPeers.includes(p))) throw invalid();
    if (input.builtin !== undefined) {
      exact(input.builtin, ['identityServerSha256','fiscalServerSha256','masterBindings','batchPolicyBindings']);
      if (![input.builtin.identityServerSha256,input.builtin.fiscalServerSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
          !Array.isArray(input.builtin.masterBindings) || !input.builtin.masterBindings.length || input.builtin.masterBindings.length > 100 ||
          !input.builtin.masterBindings.every(validB2bBinding) || new Set(input.builtin.masterBindings.map((b:B2bBinding)=>b.issuerId)).size !== input.builtin.masterBindings.length ||
          input.builtin.masterBindings.some((b:B2bBinding)=>!input.allowedRucs.includes(b.issuerRuc))) throw invalid();
      const boundaries = batchPolicyBoundaries(input.builtin.batchPolicyBindings);
      if (boundaries.some(e=>!input.builtin.masterBindings.some((b:B2bBinding)=>adminDigest(b)===adminDigest(e.anchor)))) throw invalid();
    }
    exact(input.reports, ['corrections','guides']);
    if (!Array.isArray(input.reports.corrections) || !input.reports.corrections.length || !Array.isArray(input.reports.guides) || !input.reports.guides.length ||
        input.reports.corrections.length + input.reports.guides.length > 500 || !input.reports.corrections.every(validB2bCorrectionBinding) || !input.reports.guides.every(validB2bGuideIssueBinding) ||
        input.reports.corrections.some((b: B2bCorrectionBinding) => !input.allowedRucs.includes(b.reference.issuerRuc)) ||
        input.reports.guides.some((b: B2bGuideIssueBinding) => !input.allowedRucs.includes(b.draft.anchor.issuerRuc))) throw invalid();
    exact(input.redis, ['host','port']);
    if (typeof input.redis.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(input.redis.host) || !Number.isInteger(input.redis.port) || input.redis.port < 1 || input.redis.port > 65535) throw invalid();
    if (typeof input.printRoot !== 'string' || !isAbsolute(input.printRoot) || resolve(input.printRoot) === parse(input.printRoot).root) throw invalid();
    return structuredClone(input) as BillingHostConfig;
  } catch { throw invalid(); }
}
export function validateBillingHostCredentials(input: BillingHostCredentials): BillingHostCredentials {
  try {
    exact(input, ['databaseUrl','databaseCa','redisPassword','redisPasswordFile','apiTls','operatorTls','identityTls','fiscalTls',...(input && Object.hasOwn(input,'authorityTls') ? ['authorityTls'] : [])]);
    if (typeof input.databaseUrl !== 'string' || input.databaseUrl.length > 4096 || /[\s\x00]/.test(input.databaseUrl)) throw invalid();
    const db = new URL(input.databaseUrl);
    if (!['postgresql:','postgres:'].includes(db.protocol) || !db.hostname || !db.username || !db.password || db.pathname.length < 2 || db.hash || db.search || !db.pathname.endsWith('_beta')) throw invalid();
    billingHostDatabaseOptions(input);
    if (!Buffer.isBuffer(input.redisPassword) || !input.redisPassword.length || input.redisPassword.length > 4096 ||
        !isAbsolute(input.redisPasswordFile) || !input.redisPassword.toString('utf8').trim()) throw invalid();
    const tls = (v: BillingRuntimeTls) => {
      exact(v, ['ca','cert','key']);
      if (![v.ca,v.cert,v.key].every(b => Buffer.isBuffer(b) && b.length > 0 && b.length <= 32768)) throw invalid();
      const cert = new X509Certificate(v.cert);
      if (!cert.checkPrivateKey(createPrivateKey(v.key)) || Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw invalid();
      createSecureContext(v); return { ca: Buffer.from(v.ca), cert: Buffer.from(v.cert), key: Buffer.from(v.key) };
    };
    const copy = { databaseUrl: input.databaseUrl, databaseCa:Buffer.from(input.databaseCa), redisPassword: Buffer.from(input.redisPassword), redisPasswordFile: input.redisPasswordFile,
      apiTls: tls(input.apiTls), operatorTls: tls(input.operatorTls), identityTls: tls(input.identityTls), fiscalTls: tls(input.fiscalTls), ...(input.authorityTls ? { authorityTls: tls(input.authorityTls) } : {}) };
    if (new X509Certificate(copy.apiTls.cert).fingerprint256 === new X509Certificate(copy.operatorTls.cert).fingerprint256) throw invalid();
    if (copy.authorityTls && [copy.apiTls,copy.operatorTls,copy.identityTls,copy.fiscalTls].some(v=>new X509Certificate(v.cert).fingerprint256===new X509Certificate(copy.authorityTls!.cert).fingerprint256)) throw invalid();
    return copy;
  } catch { throw Error('BILLING_HOST_MOUNTED_CREDENTIALS_INVALID'); }
}
/** Mounted, fixed filenames only; no .env loading or directory discovery. */
export function loadBillingHostMount(root: string) {
  const files = new B2bRuntimeFiles(root), config = validateBillingHostConfig(files.metadata('billing-host.json'));
  const tls = (role: string) => ({ ca: files.publicPem(`billing-${role}-ca.pem`), cert: files.publicPem(`billing-${role}-cert.pem`), key: files.privatePem(`billing-${role}-key.pem`) });
  const credentials = validateBillingHostCredentials({ databaseUrl: files.secretBytes('billing-database.bin').toString('utf8').trim(),databaseCa:files.publicPem('database-ca.pem'),
    redisPassword: files.secretBytes('billing-redis.bin'), redisPasswordFile: resolve(root, 'billing-redis.bin'),
    apiTls: tls('api'), operatorTls: tls('operator'), identityTls: tls('identity'), fiscalTls: tls('fiscal'), ...(config.builtin ? {authorityTls:tls('authority')} : {}) });
  return { config, credentials };
}
/** Do not hand node-postgres a URL with TLS options that can override its CA. */
export function billingHostDatabaseOptions(credentials:Pick<BillingHostCredentials,'databaseUrl'|'databaseCa'>){
 const url=new URL(credentials.databaseUrl);
 if(!['postgresql:','postgres:'].includes(url.protocol)||url.search||url.hash||!url.pathname.endsWith('_beta'))throw Error('BILLING_HOST_VERIFIED_DATABASE_REQUIRED');
 return b2bPostgresOptions({host:url.hostname,port:Number(url.port||5432),user:decodeURIComponent(url.username),database:decodeURIComponent(url.pathname.slice(1)),password:decodeURIComponent(url.password),
  ssl:{ca:credentials.databaseCa,rejectUnauthorized:true,minVersion:'TLSv1.2'},max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});
}
