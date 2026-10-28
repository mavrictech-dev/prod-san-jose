import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, Optional } from '@nestjs/common';
import { identity, privateJson, UUID, AccessError } from '@factuez/service-access';
import { buildGreQaUbl, validateGreQaInput, GRE_QA_PROFILE, GRE_QA_UBIGEOS, GRE_QA_UNITS, GRE_QA_WARNING, type GreQaInput, type GreQaSnapshot } from '@factuez/sunat-core/dist/gre-ubl';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { GreQaSigningService } from './gre-qa-sign.service';
import { simulateGreQa } from './gre-qa-simulator';
import type { FrozenPrintPresentationV1 } from '@factuez/contracts';
import { CurrentPdfService } from './current-pdf.service';
type Stored = { storageKey: string; sha256: string; sizeBytes: number };
type Row = { id: string; actorId: string; idempotencyKey: string; issuerRuc: string; companyId: number; originBranchId: string; destinationBranchId: string; localIdentifier: string; ublNumber: string; payload: GreQaSnapshot; inputSha256: string; xmlArtifact: Stored; zipArtifact: Stored; signatureVerified: boolean; digestValue: string | null; certificateFingerprint: string | null; credentialRevision: number | null; xsdEvidence: unknown; state: string; simulation: ReturnType<typeof simulateGreQa> | null; createdAt: Date };
type Catalog = { capabilities: { fiscalTransmission: boolean }; companies: { id: number; ruc: string; legalName: string; environment: string }[]; branches: { id: string; companyId: number; name: string }[] };
@Injectable()
export class GreQaService {
  constructor(private readonly prisma: PrismaService, private readonly store: ArtifactStore, private readonly vault: SecretVault, private readonly signer: GreQaSigningService, private readonly xsd: XsdValidationService,
    @Optional() private readonly previews: CurrentPdfService = new CurrentPdfService()) {}
  private enabled() { if (process.env.GRE_QA_ENABLED !== 'true' || process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'true' || process.env.GRE_EXTERNAL_TRANSMISSION_ENABLED === 'true') throw new ServiceUnavailableException('GRE local requiere transmisión externa deshabilitada'); }
  async authorize(authorization?: string) {
    this.enabled();
    try {
      const user = await identity(authorization ?? '', 'sunat.configure');
      if (!user.roles.includes('ADMIN') || user.scope.kind !== 'GLOBAL' || !user.permissions.includes('document.view')) throw new ForbiddenException('GRE QA sólo para administrador general');
      return user;
    } catch (e) {
      if (e instanceof AccessError) throw new HttpException(e.status === 403 ? 'Permiso GRE insuficiente' : 'Sesión GRE no disponible', e.status);
      throw e;
    }
  }
  private async context(input: Pick<GreQaInput,'companyId' | 'origin' | 'destination'>, authorization?: string) {
    const user = await this.authorize(authorization);
    const catalog = await privateJson<Catalog>(process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002', '/api/v1/documents/catalog/issuance', authorization!);
    if (!Array.isArray(catalog.companies) || !Array.isArray(catalog.branches) || catalog.capabilities?.fiscalTransmission !== false) throw new ServiceUnavailableException('Catálogo de desarrollo no disponible');
    const issuer = catalog.companies.find(c => c.id === input.companyId);
    if (!issuer || issuer.environment !== 'BETA' || !/^00\d{9}$/.test(issuer.ruc) || !issuer.legalName?.trim()) throw new ForbiddenException('Sólo emisor ficticio 00… en BETA');
    for (const point of [input.origin,input.destination]) if (!catalog.branches.some(b => b.id === point.branchId && b.companyId === issuer.id)) throw new ForbiddenException('Origen y destino deben ser sedes activas del mismo emisor autorizado');
    return { user, issuer };
  }
  private view(row: Row) {
    return { id: row.id, localIdentifier: row.localIdentifier, ublNumber: row.ublNumber, issuerRuc: row.issuerRuc, companyId: row.companyId, state: row.state, snapshot: row.payload,
      signatureVerified: row.signatureVerified, digestValue: row.digestValue, certificateFingerprint: row.certificateFingerprint, xsdValidated: Boolean(row.xsdEvidence), xsdEvidence: row.xsdEvidence,
      officialCdr: false, fiscalTransmission: false, certificateTrusted: false, sunatRulesValidated: false, authorizedForTransfer: false,
      profile: GRE_QA_PROFILE, warning: GRE_QA_WARNING, simulation: row.simulation, createdAt: row.createdAt };
  }
  async capabilities(authorization?: string) {
    await this.authorize(authorization);
    return { enabled: true, profile: GRE_QA_PROFILE, reasonCodes: ['04'], ubigeos: GRE_QA_UBIGEOS, itemUnits: GRE_QA_UNITS, officialCdr: false, fiscalTransmission: false, warning: GRE_QA_WARNING };
  }
  async list(authorization?: string, company?: string) {
    await this.authorize(authorization);
    if (company !== undefined && !/^[1-9]\d{0,9}$/.test(company)) throw new BadRequestException('Emisor inválido');
    const rows = company ? await this.prisma.$queryRaw<Row[]>`SELECT * FROM "GreQaGuide" WHERE "companyId"=${Number(company)} ORDER BY "createdAt" DESC LIMIT 50` : await this.prisma.$queryRaw<Row[]>`SELECT * FROM "GreQaGuide" ORDER BY "createdAt" DESC LIMIT 50`;
    const values = [];
    for (const row of rows) { try { await this.context(row.payload,authorization); values.push(this.view(row)); } catch (e) { if (e instanceof ForbiddenException) continue; throw e; } }
    return { items: values };
  }
  private async row(id: string, authorization?: string) {
    await this.authorize(authorization);
    if (!UUID.test(id)) throw new BadRequestException('Identificador GRE inválido');
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT * FROM "GreQaGuide" WHERE "id"=${id}::uuid LIMIT 1`;
    if (!rows[0]) throw new NotFoundException('GRE local no encontrada');
    await this.context(rows[0].payload,authorization);
    return rows[0];
  }
  async detail(id: string, authorization?: string) { return this.view(await this.row(id,authorization)); }
  async prepare(body: unknown, idempotencyKey: string | undefined, authorization?: string) {
    await this.authorize(authorization);
    if (!idempotencyKey || !UUID.test(idempotencyKey)) throw new BadRequestException('Idempotency-Key UUID requerido');
    const issued = new Date(), issueDate = new Intl.DateTimeFormat('sv-SE',{ timeZone: 'America/Lima' }).format(issued);
    let input: GreQaInput;
    try { input = validateGreQaInput(body,issueDate); } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : 'GRE inválida'); }
    const context = await this.context(input,authorization);
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = await this.prisma.$queryRaw<Row[]>`SELECT * FROM "GreQaGuide" WHERE "actorId"=${context.user.sub}::uuid AND "idempotencyKey"=${idempotencyKey}::uuid LIMIT 1`;
    if (prior[0]) { if (prior[0].inputSha256 !== inputSha256) throw new ConflictException('La clave idempotente ya fue usada con otros datos'); return this.view(prior[0]); }
    const id = randomUUID(), ublNumber = `TQ00-${parseInt(id.slice(0,8),16) % 99999999 + 1}`;
    const printPresentation = process.env.PRINT_SETTINGS_ENABLED === 'true' ? await privateJson<FrozenPrintPresentationV1>(
      process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002',
      `/api/v1/stations/print-settings/${input.companyId}/snapshot?branchId=${encodeURIComponent(input.origin.branchId)}`, authorization!) : undefined;
    if (printPresentation && (printPresentation.issuerRuc !== context.issuer.ruc || printPresentation.branchId !== input.origin.branchId))
      throw new ConflictException('La presentación GRE no corresponde al emisor y sede autorizados');
    const snapshot: GreQaSnapshot = { ...input, id, localIdentifier: `GRE-QA-${id}`, ublNumber, issueDate, issueTime: new Intl.DateTimeFormat('en-GB',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(issued),
      ...(printPresentation ? { branchId: input.origin.branchId, printPresentation } : {}),
      issuer: { ruc: context.issuer.ruc, legalName: context.issuer.legalName.trim() }, profile: GRE_QA_PROFILE, environment: 'BETA' };
    const unsigned = buildGreQaUbl(snapshot);
    let xml = unsigned, digestValue: string | null = null, certificateFingerprint: string | null = null, credentialRevision: number | null = null;
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: snapshot.issuer.ruc, environment: 'BETA' } } });
    if (credentials?.certificateCipher && credentials.certificatePasswordCipher) {
      if (credentials.certificateSelfSigned !== true || !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= issued) throw new ConflictException('GRE QA requiere certificado ficticio vigente; no utilizar certificado real');
      const p12 = this.vault.open(credentials.certificateCipher,{ruc:snapshot.issuer.ruc,environment:'BETA',field:'certificate'});
      let password: Buffer | undefined;
      try { password = this.vault.open(credentials.certificatePasswordCipher,{ruc:snapshot.issuer.ruc,environment:'BETA',field:'certificatePassword'}); const signed = await this.signer.sign(unsigned,p12,password.toString()); xml = signed.xml; digestValue = signed.digestValue; certificateFingerprint = signed.certificateFingerprintSha256; credentialRevision = credentials.revision; }
      finally { p12.fill(0); password?.fill(0); }
    }
    const evidence = await this.xsd.validate(xml,'DespatchAdvice' as Parameters<XsdValidationService['validate']>[1]);
    const fileName = `${snapshot.issuer.ruc}-09-${ublNumber}-QA`, bytes = Buffer.from(xml);
    const xmlArtifact = await this.store.put(id,`${fileName}.xml`,bytes);
    const zipArtifact = await this.store.put(id,`${fileName}.zip`,Buffer.from(zipSync({ [`${snapshot.issuer.ruc}-09-${ublNumber}.xml`]: bytes },{level:6})));
    const current = await this.context(input,authorization);
    if (current.user.sub !== context.user.sub || current.issuer.ruc !== snapshot.issuer.ruc || current.issuer.legalName.trim() !== snapshot.issuer.legalName) throw new ConflictException('Contexto GRE cambió durante la preparación');
    const row = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.user.sub}:${idempotencyKey}`},0))`;
      const concurrent = await tx.$queryRaw<Row[]>`SELECT * FROM "GreQaGuide" WHERE "actorId"=${context.user.sub}::uuid AND "idempotencyKey"=${idempotencyKey}::uuid LIMIT 1`;
      if (concurrent[0]) { if (concurrent[0].inputSha256 !== inputSha256) throw new ConflictException('Clave idempotente con distintos datos'); return concurrent[0]; }
      if (credentialRevision !== null) { const latest = await tx.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:snapshot.issuer.ruc,environment:'BETA'}}}); if (latest?.revision !== credentialRevision) throw new ConflictException('Certificado GRE cambió; repita con nueva clave'); }
      const rows = await tx.$queryRaw<Row[]>`INSERT INTO "GreQaGuide" ("id","actorId","idempotencyKey","issuerRuc","companyId","originBranchId","destinationBranchId","localIdentifier","ublNumber","payload","inputSha256","xmlArtifact","zipArtifact","signatureVerified","digestValue","certificateFingerprint","credentialRevision","xsdEvidence") VALUES (${id}::uuid,${context.user.sub}::uuid,${idempotencyKey}::uuid,${snapshot.issuer.ruc},${input.companyId},${input.origin.branchId}::uuid,${input.destination.branchId}::uuid,${snapshot.localIdentifier},${ublNumber},${JSON.stringify(snapshot)}::jsonb,${inputSha256},${JSON.stringify(xmlArtifact)}::jsonb,${JSON.stringify(zipArtifact)}::jsonb,${Boolean(digestValue)},${digestValue},${certificateFingerprint},${credentialRevision},${JSON.stringify(evidence)}::jsonb) RETURNING *`;
      return rows[0];
    });
    return this.view(row);
  }
  async simulate(id: string, scenario: unknown, authorization?: string) {
    const row = await this.row(id,authorization);
    if (!row.signatureVerified || !row.xsdEvidence) throw new ConflictException('Antes de simular, configure certificado ficticio y prepare XML firmado/XSD');
    await this.checkCredentialRevision(row);
    let simulation: ReturnType<typeof simulateGreQa>;
    try { simulation = simulateGreQa(scenario,row.localIdentifier); } catch { throw new BadRequestException('Escenario GRE inválido'); }
    if (row.simulation) { if (row.simulation.scenario !== scenario) throw new ConflictException('Un escenario por GRE local; no reenvío'); return this.view(row); }
    await this.store.read(id,row.xmlArtifact); await this.store.read(id,row.zipArtifact);
    await this.context(row.payload,authorization);
    await this.checkCredentialRevision(row);
    const changed = await this.prisma.$queryRaw<Row[]>`UPDATE "GreQaGuide" SET "state"=${simulation.state},"simulation"=${JSON.stringify(simulation)}::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=${id}::uuid AND "state"='PREPARED_LOCAL' AND "simulation" IS NULL RETURNING *`;
    if (!changed[0]) { const current = await this.row(id,authorization); if (current.simulation?.scenario !== scenario) throw new ConflictException('Simulación GRE ya iniciada'); return this.view(current); }
    return this.view(changed[0]);
  }
  private async checkCredentialRevision(row: Row) {
    if(row.credentialRevision === null)return;
    const credentials=await this.prisma.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:row.issuerRuc,environment:'BETA'}}});
    if(credentials?.revision!==row.credentialRevision || credentials.certificateFingerprint!==row.certificateFingerprint || credentials.certificateSelfSigned!==true || !credentials.certificateExpiresAt || credentials.certificateExpiresAt<=new Date())throw new ConflictException('Certificado cambió o venció; representación anterior bloqueada');
  }
  async download(id: string, format: string, authorization?: string) {
    const row = await this.row(id,authorization);
    if (!['xml','zip','ticket','a4'].includes(format)) throw new BadRequestException('Formato GRE inválido');
    await this.checkCredentialRevision(row);
    await this.store.read(id,row.xmlArtifact);
    if(format==='ticket'||format==='a4')return{bytes:await this.previews.gre(row.payload,{companyId:row.companyId,branchId:row.originBranchId},format,authorization,row.digestValue??undefined),mediaType:'application/pdf',fileName:`${row.issuerRuc}-09-${row.ublNumber}-${format}-PRUEBA.pdf`};
    return { bytes: await this.store.read(id,format === 'xml' ? row.xmlArtifact : row.zipArtifact), mediaType: format === 'xml' ? 'application/xml' : 'application/zip', fileName: `${row.issuerRuc}-09-${row.ublNumber}-PRUEBA.${format}` };
  }
}
