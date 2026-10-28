import { Injectable, BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Queue, Worker } from 'bullmq';
import { redisConnection, LivePublisher, UUID } from '@factuez/service-access';
import { limaIssueDate } from '@factuez/sunat-core';
import { unzipSync } from 'fflate';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { FiscalBatchQa, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/prisma.service';
import { LocalXmlValidationService } from './local-xml-validation.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { BatchQaWorkerService } from '../infrastructure/crypto/batch-qa-worker.service';
import { validateBatchQa, type BatchQaInput, type BatchQaKind, MAX_BATCH_QA_MEMBERS } from '../infrastructure/crypto/local-batch';
import { BoundedSoapAdapter, SoapSubmissionError, QA_SCENARIOS, type QaScenario } from '../infrastructure/sunat/bounded-soap.adapter';
import { XsdValidationService, XSD_PROFILE, XSD_ARCHIVE_SHA256 } from '../infrastructure/sunat/xsd-validation.service';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { isRetryableLocalPreparationError, LOCAL_PREPARATION_MAX_ATTEMPTS, localPreparationRetryDelay } from './local-preparation-policy';

type Stored = { storageKey: string; sha256: string; sizeBytes: number };
type Request = { kind: BatchQaKind; documentIds: string[]; scenario: QaScenario; reasons?: string[]; notDelivered?: boolean };
const QUEUE = 'fiscal-batch-local-qa-v1';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class PreparationLeaseLost extends Error {}
export function parseBatchQaRequest(body: unknown): Request {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Lote inválido');
  const b = body as Request;
  if (Object.keys(b).some(key => !['kind','documentIds','scenario','reasons','notDelivered'].includes(key)) || !['RC_ALTA','RC_BAJA','RA'].includes(b.kind) ||
    !QA_SCENARIOS.includes(b.scenario) || !Array.isArray(b.documentIds) || !b.documentIds.length || b.documentIds.length > MAX_BATCH_QA_MEMBERS ||
    b.documentIds.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(b.documentIds).size !== b.documentIds.length) throw new BadRequestException('Seleccione de 1 a 50 documentos distintos y un escenario válido');
  if (b.kind === 'RA' && (b.notDelivered !== true || !Array.isArray(b.reasons) || b.reasons.length !== b.documentIds.length || b.reasons.some(reason => typeof reason !== 'string' || !reason.trim() || reason.length > 100 || /[\x00-\x1f\x7f]/.test(reason)))) throw new BadRequestException('Indique un motivo por factura y declare que no se entregaron');
  if (b.kind !== 'RA' && (b.reasons !== undefined || b.notDelivered !== undefined)) throw new BadRequestException('Campos de RA no aplican a RC');
  const entries = b.documentIds.map((id,index) => ({ id: id.toLowerCase(), reason: b.reasons?.[index]?.trim() })).sort((a,c) => a.id.localeCompare(c.id));
  if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new BadRequestException('Documento repetido');
  return { kind: b.kind, documentIds: entries.map(e => e.id), scenario: b.scenario, ...(b.kind === 'RA' ? { reasons: entries.map(e => e.reason!), notDelivered: true } : {}) };
}
@Injectable()
export class FiscalBatchQaService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout; private dispatching = false;
  private readonly live = new LivePublisher();
  constructor(private readonly prisma: PrismaService, private readonly local: LocalXmlValidationService, private readonly store: ArtifactStore,
    private readonly vault: SecretVault, private readonly signer: BatchQaWorkerService, private readonly xsd: XsdValidationService) {}
  private enabled() { if (process.env.FISCAL_BATCH_QA_ENABLED !== 'true' || process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true' || process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'true') throw new ServiceUnavailableException('Lotes locales QA deshabilitados'); }
  private view(row: FiscalBatchQa) {
    const input = row.immutablePayload as unknown as BatchQaInput;
    const proof = row.xsdEvidence as null | { profile: string; archiveSha256: string; xmlSha256: string };
    return { id: row.id, issuerRuc: row.issuerRuc, kind: row.kind, identifier: row.identifier, state: row.state, scenario: row.scenario,
      documents: input.snapshots.map(s => ({ id: s.documentId, fullNumber: s.fullNumber, amount: s.totals.payableAmount })),
      requestFileName: row.requestFileName, ticket: row.ticket, pollAttempts: row.pollAttempts, responseCode: row.responseCode, description: row.description, notes: row.notes,
      digestValue: row.digestValue, cdrAvailable: Boolean(row.cdrZipArtifact), createdAt: row.createdAt,
      xsdValidated: Boolean(proof?.profile === XSD_PROFILE && proof.archiveSha256 === XSD_ARCHIVE_SHA256 && proof.xmlSha256 === (row.signedXmlArtifact as unknown as Stored | null)?.sha256),
      localOnly: true, officialCdr: false, fiscalTransmission: false, modifiesSale: false, sunatRulesValidated: false };
  }
  private async checkAccess(row: FiscalBatchQa, authorization?: string) {
    const input = row.immutablePayload as unknown as BatchQaInput;
    try { validateBatchQa(input); } catch { throw new ConflictException('Lote archivado inconsistente'); }
    for (const original of input.snapshots) {
      const context = await this.local.context(original.documentId, authorization);
      if (context.credentials.revision !== row.credentialRevision || !isDeepStrictEqual(context.snapshot, original)) throw new ConflictException('Credenciales o comprobantes cambiaron; lote bloqueado');
    }
  }
  private async get(id: string, authorization?: string) {
    this.enabled(); if (!UUID.test(id)) throw new BadRequestException('Lote inválido');
    const row = await this.prisma.fiscalBatchQa.findUnique({ where: { id } }); if (!row) throw new NotFoundException('Lote no disponible');
    await this.checkAccess(row, authorization); return row;
  }
  async status(id: string, authorization?: string) { return this.view(await this.get(id,authorization)); }
  async list(authorization?: string) {
    this.enabled(); const rows = await this.prisma.fiscalBatchQa.findMany({ orderBy: { createdAt: 'desc' }, take: 30 });
    const items = []; let unavailableCount=0;
    for (const row of rows) {
      try { await this.checkAccess(row,authorization); items.push(this.view(row)); }
      catch(e) { if(e instanceof ConflictException){unavailableCount++;continue;}throw e; }
    }
    return { items, unavailableCount, localOnly: true, maxMembers: MAX_BATCH_QA_MEMBERS };
  }
  async start(body: unknown, key: string | undefined, actorId: string, authorization?: string) {
    this.enabled(); if (!key || !UUID.test(key)) throw new BadRequestException('Idempotency-Key UUID requerido');
    const request = parseBatchQaRequest(body); const contexts = [];
    for (const id of request.documentIds) contexts.push(await this.local.context(id,authorization));
    const input: BatchQaInput = { kind: request.kind, snapshots: contexts.map(c => c.snapshot), ...(request.kind === 'RA' ? { reasons: request.reasons, notDelivered: true } : {}) };
    let issuerRuc: string;
    try { issuerRuc = validateBatchQa(input).issuerRuc; } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : 'Lote inválido'); }
    const credentials = contexts[0].credentials; const inputSha256 = hash(request);
    const idempotencyKey = key.toLowerCase();
    const prior = await this.prisma.fiscalBatchQa.findUnique({ where: { issuerRuc_idempotencyKey: { issuerRuc,idempotencyKey } } });
    if (prior) {
      if (prior.inputSha256 !== inputSha256) throw new ConflictException('Clave idempotente usada con otros datos');
      await this.checkAccess(prior,authorization);
      if (prior.state === 'BUILDING') await this.prepare(prior, () => this.checkAccess(prior, authorization));
      return this.view(await this.prisma.fiscalBatchQa.findUniqueOrThrow({ where: { id: prior.id } }));
    }
    const day = limaIssueDate(new Date().toISOString()).replaceAll('-','');
    const action = request.kind === 'RC_ALTA' ? 'ALTA' : 'BAJA';
    const row = await this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',`${issuerRuc}:BETA`);
      const concurrent = await tx.fiscalBatchQa.findUnique({ where: { issuerRuc_idempotencyKey: { issuerRuc,idempotencyKey } } });
      if (concurrent) { if (concurrent.inputSha256 !== inputSha256) throw new ConflictException('Clave idempotente usada con otros datos'); return concurrent; }
      const current = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc,environment: 'BETA' } } });
      if (current?.revision !== credentials.revision || current.certificateFingerprint !== credentials.certificateFingerprint) throw new ConflictException('El certificado cambió');
      for (const snapshot of input.snapshots) {
        const original = await tx.fiscalDocument.findUnique({ where: { documentId: snapshot.documentId } });
        if (!original || !['BUILDING','QUEUED'].includes(original.status) || !isDeepStrictEqual(original.immutablePayload, JSON.parse(JSON.stringify(snapshot)))) throw new ConflictException('Original cambió');
        const member = await tx.fiscalBatchQaMember.findUnique({ where: { documentId_action: { documentId: snapshot.documentId,action } } });
        if (member) throw new ConflictException('Documento ya reservado en un lote para esta acción; no reenviar');
        const circuit = await tx.fiscalCircuitQa.findUnique({ where: { documentId: snapshot.documentId } });
        if (action === 'ALTA' && circuit) throw new ConflictException('Boleta ya tiene un circuito individual; use otra boleta para alta múltiple');
        if (action === 'BAJA') {
          const alta = await tx.fiscalBatchQaMember.findUnique({ where: { documentId_action: { documentId: snapshot.documentId,action:'ALTA' } }, include: { batch:true } });
          if (!(circuit?.cdrZipArtifact && ['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(circuit.state)) && !(alta?.batch.cdrZipArtifact && ['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(alta.batch.state))) throw new ConflictException('Baja QA requiere alta aceptada por emulador');
        }
      }
      const counterId = request.kind === 'RA' ? `${issuerRuc}:RA:${day}` : `${issuerRuc}:${day}`;
      const counter = await tx.fiscalQaCounter.upsert({ where: { id: counterId }, create: { id: counterId,lastNumber:1 }, update: { lastNumber: { increment:1 } } });
      if (counter.lastNumber > 99999) throw new ConflictException('Límite de lotes QA alcanzado');
      const identifier = `${request.kind === 'RA' ? 'RA' : 'RC'}-${day}-${counter.lastNumber}`;
      return tx.fiscalBatchQa.create({ data: { id: randomUUID(), issuerRuc, idempotencyKey, inputSha256, kind:request.kind, identifier, actorId,
        credentialRevision:credentials.revision, scenario:request.scenario, immutablePayload:JSON.parse(JSON.stringify(input)), requestFileName:`${issuerRuc}-${identifier}.zip`, notes:[],
        members: { create: input.snapshots.map(s => ({ id:randomUUID(), documentId:s.documentId, action })) } } });
    }, { timeout:15000 });
    if (row.state === 'BUILDING') await this.prepare(row, () => this.checkAccess(row, authorization));
    return this.view(await this.prisma.fiscalBatchQa.findUniqueOrThrow({ where: { id: row.id } }));
  }

  /** Contexto propio de SUNAT, sólo reservas QA admitidas previamente por JWT.
   * No consulta otras bases, no toma un RUC libre y nunca usa certificados reales. */
  private async storedContext(row: FiscalBatchQa) {
    const input = row.immutablePayload as unknown as BatchQaInput;
    const validated = validateBatchQa(input);
    if (validated.issuerRuc !== row.issuerRuc || !/^00\d{9}$/.test(row.issuerRuc)) throw new ConflictException('Emisor ficticio inconsistente');
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: row.issuerRuc, environment: 'BETA' } } });
    if (credentials?.revision !== row.credentialRevision || credentials.certificateSelfSigned !== true || !credentials.certificateFingerprint ||
      !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() || !credentials.certificateCipher || !credentials.certificatePasswordCipher)
      throw new ConflictException('El contexto de certificado QA cambió');
    for (const snapshot of input.snapshots) {
      const original = await this.prisma.fiscalDocument.findUnique({ where: { documentId: snapshot.documentId } });
      if (!original || original.environment !== 'BETA' || original.issuerRuc !== row.issuerRuc || !['QUEUED', 'BUILDING'].includes(original.status) ||
        !isDeepStrictEqual(original.immutablePayload, JSON.parse(JSON.stringify(snapshot)))) throw new ConflictException('Original QA cambió');
    }
    return { input, credentials };
  }

  private async prepare(row: FiscalBatchQa, authorize?: () => Promise<void>) {
    if (row.state !== 'BUILDING' || row.claimedAt || row.nextPollAt > new Date()) return;
    if (row.pollAttempts >= LOCAL_PREPARATION_MAX_ATTEMPTS) {
      await this.prisma.fiscalBatchQa.updateMany({ where: { id: row.id, state: 'BUILDING', claimedAt: null, pollAttempts: row.pollAttempts },
        data: { state: 'BLOCKED', responseCode: 'QA_PREPARATION_RETRY_LIMIT', description: 'Límite de preparación local alcanzado; conservar reserva para revisión' } });
      return;
    }
    // claimedAt es token estable; updatedAt es heartbeat. pollAttempts cerca el
    // intento de preparación, y vuelve a cero al pasar a la fase de transporte.
    const owner = new Date(); const attempt = row.pollAttempts + 1;
    const fence = { id: row.id, state: 'BUILDING', claimedAt: owner, pollAttempts: attempt };
    const claimed = await this.prisma.fiscalBatchQa.updateMany({
      where: { id: row.id, state: 'BUILDING', claimedAt: null, pollAttempts: row.pollAttempts, nextPollAt: { lte: owner } },
      data: { claimedAt: owner, updatedAt: owner, pollAttempts: attempt },
    });
    if (claimed.count !== 1) return;
    let lost = false; let beating: Promise<void> | undefined;
    const refresh = async () => {
      if (lost) throw new PreparationLeaseLost();
      const result = await this.prisma.fiscalBatchQa.updateMany({ where: { ...fence, updatedAt: { gt: new Date(Date.now() - 60000) } }, data: { updatedAt: new Date() } });
      if (result.count !== 1) { lost = true; throw new PreparationLeaseLost(); }
    };
    const timer = setInterval(() => {
      if (beating || lost) return;
      beating = refresh().catch(() => { lost = true; }).finally(() => { beating = undefined; });
    }, 10000); timer.unref();
    const stop = async () => { clearInterval(timer); await beating; };
    try {
      await authorize?.();
      const { input, credentials } = await this.storedContext(row);
      const secretContext = { ruc:row.issuerRuc,environment:'BETA' };
      const bytes = this.vault.open(credentials.certificateCipher!,{...secretContext,field:'certificate'}); let password:Buffer|undefined;
      let prepared:Awaited<ReturnType<BatchQaWorkerService['prepare']>>;
      try { password=this.vault.open(credentials.certificatePasswordCipher!,{...secretContext,field:'certificatePassword'}); prepared=await this.signer.prepare(input,row.identifier,bytes,password.toString()); }
      finally { bytes.fill(0); password?.fill(0); }
      if (prepared.certificateFingerprintSha256 !== credentials.certificateFingerprint) throw new ConflictException('Firma no coincide con certificado');
      const evidence=await this.xsd.validate(prepared.xml,row.kind==='RA'?'VoidedDocuments':'SummaryDocuments');
      const xml=await this.store.put(row.id,`QA-BATCH-${row.id}.xml`,Buffer.from(prepared.xml));
      const zip=await this.store.put(row.id,`QA-BATCH-${row.id}.zip`,prepared.zip);
      await authorize?.(); await this.storedContext(row); await refresh(); await stop();
      if (lost) throw new PreparationLeaseLost();
      await this.prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',`${row.issuerRuc}:BETA`);
        const current=await tx.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:row.issuerRuc,environment:'BETA'}}});
        if (current?.revision!==row.credentialRevision || current.certificateFingerprint !== credentials.certificateFingerprint) throw new ConflictException('Certificado cambió');
        const transitioned = await tx.fiscalBatchQa.updateMany({where:{...fence,updatedAt:{gt:new Date(Date.now()-60000)}},data:{state:'QUEUED',digestValue:prepared.digestValue,requestArtifact:zip,signedXmlArtifact:xml,xsdEvidence:evidence,claimedAt:null,pollAttempts:0,nextPollAt:new Date(),responseCode:null,description:'Paquete local preparado; pendiente de emulador'}});
        if (transitioned.count !== 1) throw new PreparationLeaseLost();
      });
      await this.changed(input);
    } catch (e) {
      await stop();
      if (lost || e instanceof PreparationLeaseLost) return;
      const retry = isRetryableLocalPreparationError(e) && attempt < LOCAL_PREPARATION_MAX_ATTEMPTS;
      const result = await this.prisma.fiscalBatchQa.updateMany({ where: { ...fence, updatedAt: { gt: new Date(Date.now() - 60000) } }, data: {
        state: retry ? 'BUILDING' : 'BLOCKED', claimedAt: null,
        nextPollAt: new Date(Date.now() + localPreparationRetryDelay(attempt)),
        responseCode: retry ? 'QA_PREPARATION_RETRY' : isRetryableLocalPreparationError(e) ? 'QA_PREPARATION_RETRY_LIMIT' : 'QA_PREPARATION_FAILED',
        description: retry ? 'Validador local temporalmente no disponible; misma reserva, reintento acotado pendiente' : 'Preparación detenida; conservar reserva para revisión, sin envío',
      } });
      if (result.count === 1) await this.changed(row.immutablePayload as unknown as BatchQaInput);
      if (!isRetryableLocalPreparationError(e)) throw e;
    } finally { await stop(); }
  }
  private async changed(input: BatchQaInput) { for(const s of input.snapshots) await this.live.changed(s.documentId); }
  onApplicationBootstrap() {
    if(process.env.FISCAL_BATCH_QA_ENABLED!=='true')return;
    this.enabled(); this.queue=new Queue(QUEUE,{connection:redisConnection()}); this.queue.on('error',()=>{});
    this.worker=new Worker(QUEUE,job=>this.process(String(job.data.id)),{connection:redisConnection(),concurrency:1}); this.worker.on('error',()=>{});
    this.timer=setInterval(()=>void this.dispatch(),2000);
  }
  private async dispatch() {
    if(this.dispatching||!this.queue)return; this.dispatching=true;
    try {
      const stale=new Date(Date.now()-60000);
      // Recupera sólo una lease vencida, no un lote por su antigüedad. Ningún
      // BLOCKED histórico se reactiva ni se libera/reasigna numeración.
      await this.prisma.fiscalBatchQa.updateMany({where:{state:'BUILDING',claimedAt:{lt:stale},updatedAt:{lt:stale}},data:{claimedAt:null,nextPollAt:new Date(),description:'Preparación local interrumpida; recuperar misma reserva antes del envío'}});
      await this.prisma.fiscalBatchQa.updateMany({where:{state:'SENDING',claimedAt:{lt:stale}},data:{state:'UNKNOWN',description:'Respuesta no confirmada; conciliar, no reenviar'}});
      await this.prisma.fiscalBatchQa.updateMany({where:{state:'POLLING',claimedAt:{lt:stale}},data:{state:'WAITING_TICKET',claimedAt:null,nextPollAt:new Date()}});
      const rows=await this.prisma.fiscalBatchQa.findMany({where:{OR:[{state:'BUILDING',claimedAt:null},{state:{in:['QUEUED','WAITING_TICKET']}}],nextPollAt:{lte:new Date()}},take:20,orderBy:{createdAt:'asc'}});
      for(const row of rows)await this.queue.add('local-batch',{id:row.id},{jobId:`${row.id}-${row.state}-${row.pollAttempts}`,attempts:1,removeOnComplete:100,removeOnFail:100});
    } catch { /* BD primaria, sin logs de payload. */ } finally { this.dispatching=false; }
  }
  async process(id: string) {
    this.enabled(); const row=await this.prisma.fiscalBatchQa.findUnique({where:{id}}); if(!row)return;
    if (row.state === 'BUILDING') { await this.prepare(row); return; }
    if(!['QUEUED','WAITING_TICKET'].includes(row.state) || row.nextPollAt > new Date())return;
    const polling=row.state==='WAITING_TICKET'; const active=polling?'POLLING':'SENDING';
    const owner = new Date(); const activeAttempt = row.pollAttempts + (polling ? 1 : 0);
    const claim=await this.prisma.fiscalBatchQa.updateMany({where:{id,state:row.state,pollAttempts:row.pollAttempts},data:{state:active,claimedAt:owner,...(polling?{pollAttempts:{increment:1}}:{})}}); if(claim.count!==1)return;
    const input=row.immutablePayload as unknown as BatchQaInput;
    const update=async(data:Prisma.FiscalBatchQaUpdateManyMutationInput)=>{const result=await this.prisma.fiscalBatchQa.updateMany({where:{id,state:active,claimedAt:owner,pollAttempts:activeAttempt},data:{...data,...(data.state && data.state!==active?{claimedAt:null}:{})}});if(result.count===1)await this.changed(input);return result;};
    let attempted=false;
    try {
      validateBatchQa(input);
      const credentials=await this.prisma.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:row.issuerRuc,environment:'BETA'}}});
      if(credentials?.revision!==row.credentialRevision||credentials.certificateSelfSigned!==true||!credentials.certificateExpiresAt||credentials.certificateExpiresAt<=new Date())throw new Error();
      for(const s of input.snapshots){const original=await this.prisma.fiscalDocument.findUnique({where:{documentId:s.documentId}});if(!original||original.issuerRuc!==row.issuerRuc||original.environment!=='BETA'||!['BUILDING','QUEUED'].includes(original.status)||!isDeepStrictEqual(original.immutablePayload,JSON.parse(JSON.stringify(s))))throw new Error();}
      const adapter=new BoundedSoapAdapter({environment:'LOCAL_QA',ruc:row.issuerRuc,solUser:'LOCALONLY',solPassword:'FICTICIO-NO-SUNAT',qaScenario:row.scenario as QaScenario});
      if(polling){
        if(!row.ticket)throw new Error(); const result=await adapter.getStatus(row.ticket);
        if(result.kind==='PROCESSING'){await update({state:row.pollAttempts>=19?'POLL_LIMIT':'WAITING_TICKET',nextPollAt:new Date(Date.now()+Math.min(30000,2000*2**Math.min(4,row.pollAttempts)))});return;}
        if(result.kind==='ERROR'){await update({state:'UNKNOWN',responseCode:result.code,description:'Resultado de ticket no reconocido; revisar'});return;}
        await this.archive(row,result.cdrZip,active,owner,activeAttempt);return;
      }
      const zip=await this.store.read(id,row.requestArtifact as unknown as Stored); const xml=await this.store.read(id,row.signedXmlArtifact as unknown as Stored);
      let count=0;const contents=unzipSync(zip,{filter:file=>{if(++count!==1||file.originalSize>2*1024*1024||file.name!==row.requestFileName.replace(/\.zip$/,'.xml'))throw new Error();return true;}});
      if(count!==1||!Buffer.from(Object.values(contents)[0]).equals(xml))throw new Error();
      const evidence=await this.xsd.validate(xml,row.kind==='RA'?'VoidedDocuments':'SummaryDocuments');if((await update({xsdEvidence:evidence})).count!==1)return;
      attempted=true;const ticket=await adapter.submitSummary({documentId:id,fileName:row.requestFileName,zip,sha256:(row.requestArtifact as unknown as Stored).sha256});
      await update({state:'WAITING_TICKET',ticket,pollAttempts:1,nextPollAt:new Date(Date.now()+2000)});
    }catch(e){
      if(!polling&&!attempted){
        const retry = isRetryableLocalPreparationError(e) && row.pollAttempts + 1 < LOCAL_PREPARATION_MAX_ATTEMPTS;
        await update({state:retry?'QUEUED':'BLOCKED',claimedAt:null,pollAttempts:row.pollAttempts+1,nextPollAt:new Date(Date.now()+localPreparationRetryDelay(row.pollAttempts+1)),
          description:retry?'XSD local temporalmente ocupado; reintentar antes del envío, misma reserva':'Integridad, XSD o contexto QA no válido; no enviado'});return;
      }
      if(polling&&e instanceof SoapSubmissionError&&e.kind==='UNKNOWN'){await update({state:row.pollAttempts>=19?'POLL_LIMIT':'WAITING_TICKET',description:'Consulta fallida; mismo ticket, nunca otro envío',nextPollAt:new Date(Date.now()+Math.min(30000,2000*2**Math.min(4,row.pollAttempts)))});return;}
      await update({state:'UNKNOWN',responseCode:e instanceof SoapSubmissionError?e.code:'QA_RESULT_INVALID',description:'Resultado incierto; conciliar. No se reenvía ni se cambia la venta'});
    }
  }
  private async archive(row:FiscalBatchQa,zip:Buffer,state:string,owner:Date,attempt:number){
    const cdr=parseCdrZip(zip,{fileName:`R-${row.requestFileName.replace(/\.zip$/,'.xml')}`,issuerRuc:row.issuerRuc,reference:row.identifier});
    const cdrZipArtifact=await this.store.put(row.id,`QA-BATCH-CDR-${row.id}.zip`,zip);const cdrXmlArtifact=await this.store.put(row.id,`QA-BATCH-CDR-${row.id}.xml`,cdr.xml);
    const result = await this.prisma.fiscalBatchQa.updateMany({where:{id:row.id,state,claimedAt:owner,pollAttempts:attempt},data:{state:cdr.status,responseCode:cdr.code,description:cdr.description,notes:cdr.notes,cdrZipArtifact,cdrXmlArtifact}});if(result.count===1)await this.changed(row.immutablePayload as unknown as BatchQaInput);
  }
  async download(id:string,format:string,authorization?:string){
    const row=await this.get(id,authorization);const map={xml:row.signedXmlArtifact,zip:row.requestArtifact,cdr:row.cdrZipArtifact};
    if(!Object.hasOwn(map,format))throw new BadRequestException('Formato de lote inválido');const artifact=map[format as keyof typeof map];if(!artifact)throw new ConflictException('Artefacto de lote aún no disponible');
    return{bytes:await this.store.read(id,artifact as unknown as Stored),mediaType:format==='xml'?'application/xml':'application/zip',fileName:`${row.issuerRuc}-${row.identifier}-${format}-SIMULADO.${format==='xml'?'xml':'zip'}`};
  }
  async onModuleDestroy(){if(this.timer)clearInterval(this.timer);await this.worker?.close();await this.queue?.close();await this.live.close();}
}
