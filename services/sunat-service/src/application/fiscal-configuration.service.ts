import {nativeBillingFetch} from '@factuez/service-access/dist/native-b2b-rpc';
import type { Phase8AdminContextResolver, Phase8AdminContextAction } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma.service";
import { SecretVault } from "../infrastructure/crypto/secret-vault";
import { MAX_CERTIFICATE_BYTES } from "../infrastructure/crypto/certificate-inspector";
import { CertificateInspectionService } from "../infrastructure/crypto/certificate-inspection.service";

export type ConfigurationInput = {
  expectedRevision: number;
  certificate?: { fileName: string; base64: string; password: string };
  sol?: { username: string; password: string };
  gre?: { clientId: string; clientSecret: string };
  remove?: Array<"certificate" | "sol" | "gre">;
};
type Environment = "BETA" | "PRODUCTION";

@Injectable()
export class FiscalConfigurationService {
  private ownerContext?: Phase8AdminContextResolver;
  static createWithOwnerContext(prisma: PrismaService, vault: SecretVault, certificates: CertificateInspectionService, resolver: Phase8AdminContextResolver) {
    const service = new FiscalConfigurationService(prisma, vault, certificates);
    service.ownerContext = resolver; return service;
  }
  constructor(private readonly prisma: PrismaService, private readonly vault: SecretVault, private readonly certificates: CertificateInspectionService) {}

  private async issuer(companyId: string, environment: string, authorization: string | object, action: Phase8AdminContextAction = "FISCAL_READ", payload: unknown = {}, actorId?: string) {
    if (this.ownerContext && typeof authorization === "string") throw new UnauthorizedException("Se requiere capacidad propietaria");
    if (typeof authorization !== "string") {
      if (!this.ownerContext || environment !== "BETA") throw new UnauthorizedException("Contexto propietario no disponible");
      const context = await this.ownerContext.resolve(authorization, { action, companyId, environment, payload });
      if (String(context.issuer.companyId) !== companyId || context.environment !== "BETA" || !/^[0-9]{11}$/.test(context.issuer.ruc) || !context.actorId || (actorId !== undefined && context.actorId !== actorId))
        throw new UnauthorizedException("Contexto propietario inválido");
      return { ruc: context.issuer.ruc, environment: context.environment as Environment };
    }
    if (!/^[1-9]\d{0,9}$/.test(companyId) || !["BETA", "PRODUCTION"].includes(environment))
      throw new BadRequestException("Emisor o ambiente inválido");
    let response: Response;
    try {
      response = await nativeBillingFetch('/api/v1/documents/catalog/issuance',authorization!,()=>fetch(`${process.env.BILLING_INTERNAL_URL ?? "http://billing-service:3002"}/api/v1/documents/catalog/issuance`, {
        headers: { Authorization: authorization, Accept: "application/json", "Cache-Control": "no-store" },
        signal: AbortSignal.timeout(5000), redirect: "error",
      }));
    } catch { throw new ServiceUnavailableException("No se pudo verificar el emisor en Billing"); }
    if ([401, 403].includes(response.status)) throw new UnauthorizedException("Inicie sesión nuevamente");
    if (!response.ok) throw new ServiceUnavailableException("Billing no está disponible");
    let catalog: { companies: Array<{ id: number; ruc: string; environment?: string }>; capabilities?: { productionInvoiceAdmission?: boolean } };
    try { catalog = await response.json() as typeof catalog; }
    catch { throw new ServiceUnavailableException("Respuesta de Billing inválida"); }
    if (!Array.isArray(catalog.companies)) throw new ServiceUnavailableException("Respuesta de Billing inválida");
    const issuer = catalog.companies.find(company => String(company.id) === companyId);
    if (!issuer || !/^\d{11}$/.test(issuer.ruc)) throw new NotFoundException("Emisor no disponible");
    return { ruc: issuer.ruc, environment: environment as Environment,
      ...(['BETA','PRODUCTION'].includes(issuer.environment ?? '') ? { emissionEnvironment: issuer.environment } : {}),
      ...(typeof catalog.capabilities?.productionInvoiceAdmission === 'boolean' ? { productionInvoiceAdmission: catalog.capabilities.productionInvoiceAdmission } : {}) };
  }

  async status(companyId: string, environment: string, authorization: string | object) {
    const issuer = await this.issuer(companyId, environment, authorization);
    const row = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: issuer.ruc, environment: issuer.environment } } });
    return this.view(issuer, row);
  }
  async audit(companyId: string, environment: string, authorization: string | object, page = "1") {
    const issuer = await this.issuer(companyId, environment, authorization, "FISCAL_AUDIT", { page });
    if (!/^[1-9]\d{0,5}$/.test(page)) throw new BadRequestException("Página inválida");
    const where = { issuerRuc: issuer.ruc, environment: issuer.environment };
    const pageSize = 10;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.fiscalConfigurationAudit.count({ where }),
      this.prisma.fiscalConfigurationAudit.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        skip: (Number(page) - 1) * pageSize, take: pageSize,
        select: { id: true, actorId: true, fields: true, revision: true, occurredAt: true } }),
    ], { isolationLevel: "RepeatableRead" });
    return { ...issuer, page: Number(page), pageSize, total, items };
  }
  /** Explicit same-RUC copy. Decrypt and re-seal with destination AAD; never return secrets. */
  async reuse(companyId:string,environment:string,input:unknown,authorization:string,actorId:string){
    const v=input as {sourceEnvironment:string;sourceRevision:number;expectedRevision:number;groups:Array<'certificate'|'sol'|'gre'>;overwrite:boolean;confirmation:string};
    if(!v||Object.keys(v).sort().join(',')!=='confirmation,expectedRevision,groups,overwrite,sourceEnvironment,sourceRevision'||!['BETA','PRODUCTION'].includes(v.sourceEnvironment)||v.sourceEnvironment===environment||!Number.isSafeInteger(v.sourceRevision)||v.sourceRevision<1||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0||!Array.isArray(v.groups)||!v.groups.length||v.groups.some(g=>!['certificate','sol','gre'].includes(g))||new Set(v.groups).size!==v.groups.length||typeof v.overwrite!=='boolean'||v.confirmation!=='REUTILIZAR CONFIGURACIÓN DEL MISMO RUC')throw new BadRequestException('Seleccione grupos, revisiones y confirme la reutilización del mismo RUC');
    const target=await this.issuer(companyId,environment,authorization),source=await this.issuer(companyId,v.sourceEnvironment,authorization);
    if(source.ruc!==target.ruc)throw new BadRequestException('No se permite copiar configuración entre RUC');
    return this.prisma.$transaction(async tx=>{
      // Lock in deterministic environment order, matching save's advisory locks.
      for(const env of ['BETA','PRODUCTION'])await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',`${target.ruc}:${env}`);
      const from=await tx.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:source.ruc,environment:source.environment}}}),to=await tx.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:target.ruc,environment:target.environment}}});
      if(from?.revision!==v.sourceRevision||(to?.revision??0)!==v.expectedRevision)throw new ConflictException('Las credenciales cambiaron; actualice ambos ambientes');
      const fields={certificate:['certificateCipher','certificatePasswordCipher'],sol:['solUsernameCipher','solPasswordCipher'],gre:['greClientIdCipher','greClientSecretCipher']} as const;
      const aadFields={certificateCipher:'certificate',certificatePasswordCipher:'certificatePassword',solUsernameCipher:'solUsername',solPasswordCipher:'solPassword',greClientIdCipher:'greClientId',greClientSecretCipher:'greClientSecret'} as const;
      const data:Record<string,unknown>={};
      for(const group of v.groups){
        if(fields[group].some(f=>!from[f]))throw new BadRequestException(`El grupo ${group} no está completo en el origen`);
        if(!v.overwrite&&fields[group].some(f=>to?.[f]))throw new ConflictException('El destino ya está configurado. Confirme explícitamente reemplazar los grupos elegidos');
        if(group==='certificate'){
          const bytes=this.vault.open(from.certificateCipher!,{...source,field:'certificate'}),pass=this.vault.open(from.certificatePasswordCipher!,{...source,field:'certificatePassword'});
          try{const metadata=await this.certificates.inspect(bytes,pass.toString('utf8'));if(metadata.fingerprint!==from.certificateFingerprint)throw new ConflictException('La metadata del certificado de origen no corresponde a sus bytes');if(target.environment==='PRODUCTION'&&(metadata.selfSigned||new Date(metadata.expiresAt)<=new Date()||!metadata.subjectRucCandidates.includes(target.ruc)))throw new BadRequestException('Producción requiere certificado vigente del mismo RUC y no autofirmado');Object.assign(data,{certificateFingerprint:metadata.fingerprint,certificateExpiresAt:metadata.expiresAt,certificateSelfSigned:metadata.selfSigned,certificateStorageKey:null});}finally{bytes.fill(0);pass.fill(0);}
        }
        for(const field of fields[group]){const plain=this.vault.open(from[field]!,{...source,field:aadFields[field]});try{data[field]=this.vault.seal(plain,{...target,field:aadFields[field]});}finally{plain.fill(0);}}
      }
      const current=await this.issuer(companyId,environment,authorization);if(current.ruc!==target.ruc||current.environment!==target.environment)throw new UnauthorizedException('El contexto autorizado cambió durante la reutilización');
      const row=await tx.sunatCredentials.upsert({where:{issuerRuc_environment:{issuerRuc:target.ruc,environment:target.environment}},create:{issuerRuc:target.ruc,environment:target.environment,...data,revision:1},update:{...data,revision:{increment:1}}});
      await tx.fiscalConfigurationAudit.create({data:{issuerRuc:target.ruc,environment:target.environment,actorId,fields:v.groups.map(g=>`${g}.reuse.${source.environment}`),revision:row.revision}});
      return this.view(target,row);
    },{timeout:30000});
  }
  private view(issuer: { ruc: string; environment: Environment; emissionEnvironment?: string; productionInvoiceAdmission?: boolean }, row: {
    revision: number; certificateCipher: string | null; certificateFingerprint: string | null;
    certificateExpiresAt: Date | null; certificateSelfSigned: boolean | null;
    solUsernameCipher: string | null; solPasswordCipher: string | null;
    greClientIdCipher: string | null; greClientSecretCipher: string | null; updatedAt: Date;
  } | null) {
    return {
      ...issuer, revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null,
      certificate: { configured: Boolean(row?.certificateCipher), fingerprint: row?.certificateFingerprint ?? null,
        expiresAt: row?.certificateExpiresAt ?? null, selfSigned: row?.certificateSelfSigned ?? null,
        expired: Boolean(row?.certificateExpiresAt && row.certificateExpiresAt <= new Date()),
        trustAndRucVerified: false },
      solConfigured: Boolean(row?.solUsernameCipher && row.solPasswordCipher),
      greConfigured: Boolean(row?.greClientIdCipher && row.greClientSecretCipher),
      fiscalTransmission: false,
    };
  }
  async save(companyId: string, environment: string, input: ConfigurationInput, authorization: string | object, actorId: string) {
    const issuer = await this.issuer(companyId, environment, authorization, "FISCAL_SAVE", input, actorId);
    if (!input || typeof input !== "object" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 2147483646 ||
      Array.isArray(input) || Object.keys(input).some(key => !["expectedRevision", "certificate", "sol", "gre", "remove"].includes(key)) ||
      ![input.certificate, input.sol, input.gre, input.remove?.length].some(Boolean))
      throw new BadRequestException("Configuración vacía o inválida");
    const removals = input.remove ?? [];
    if (!Array.isArray(removals) || removals.length > 3 || new Set(removals).size !== removals.length ||
      removals.some(group => !["certificate", "sol", "gre"].includes(group) || input[group]))
      throw new BadRequestException("No puede retirar y reemplazar el mismo grupo en una operación");
    const data: Record<string, string | Date | number | boolean | null> = {};
    const fields: string[] = [];
    for (const group of removals) {
      if (group === "certificate") Object.assign(data, { certificateCipher: null, certificatePasswordCipher: null,
        certificateStorageKey: null, certificateFingerprint: null, certificateExpiresAt: null, certificateSelfSigned: null });
      if (group === "sol") Object.assign(data, { solUsernameCipher: null, solPasswordCipher: null });
      if (group === "gre") Object.assign(data, { greClientIdCipher: null, greClientSecretCipher: null });
      fields.push(`${group}.remove`);
    }
    const seal = (field: string, value: string | Buffer) => this.vault.seal(value, { ...issuer, field });
    const secret = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
    if (input.certificate) {
      const certificate = input.certificate;
      if (typeof certificate.fileName !== "string" || !/\.(p12|pfx)$/i.test(certificate.fileName) ||
        !secret(certificate.password) || typeof certificate.base64 !== "string" ||
        certificate.base64.length > Math.ceil(MAX_CERTIFICATE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(certificate.base64))
        throw new BadRequestException("Archivo PKCS#12 o contraseña inválidos");
      const bytes = Buffer.from(certificate.base64, "base64");
      if (bytes.toString("base64") !== certificate.base64) throw new BadRequestException("Codificación de certificado inválida");
      try {
        const metadata = await this.certificates.inspect(bytes, certificate.password);
        Object.assign(data, { certificateCipher: seal("certificate", bytes), certificatePasswordCipher: seal("certificatePassword", certificate.password),
          certificateFingerprint: metadata.fingerprint, certificateExpiresAt: metadata.expiresAt,
          certificateSelfSigned: metadata.selfSigned, certificateStorageKey: null });
        fields.push("certificate");
      } finally { bytes.fill(0); }
    }
    if (input.sol) {
      if (!secret(input.sol.username, 80) || !/^[A-Za-z0-9._-]{3,80}$/.test(input.sol.username) || !secret(input.sol.password))
        throw new BadRequestException("Ingrese usuario secundario SOL y su contraseña");
      Object.assign(data, { solUsernameCipher: seal("solUsername", input.sol.username), solPasswordCipher: seal("solPassword", input.sol.password) });
      fields.push("sol");
    }
    if (input.gre) {
      if (!secret(input.gre.clientId, 160) || !secret(input.gre.clientSecret)) throw new BadRequestException("Ingrese Client ID y Client Secret GRE");
      Object.assign(data, { greClientIdCipher: seal("greClientId", input.gre.clientId), greClientSecretCipher: seal("greClientSecret", input.gre.clientSecret) });
      fields.push("gre");
    }
    const recheckOwner = async () => {
      if (typeof authorization === "string") return;
      const current = await this.issuer(companyId, environment, authorization, "FISCAL_SAVE", input, actorId);
      if (current.ruc !== issuer.ruc || current.environment !== issuer.environment) throw new UnauthorizedException("El contexto propietario cambió");
    };
    await recheckOwner();
    const where = { issuerRuc_environment: { issuerRuc: issuer.ruc, environment: issuer.environment } };
    try {
      const row = await this.prisma.$transaction(async tx => {
        // Bloqueo sólo del par fiscal. Evita perdidas en alta simultánea y revisiones.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${issuer.ruc}:${issuer.environment}`}, 0))`;
        const current = await tx.sunatCredentials.findUnique({ where });
        if ((current?.revision ?? 0) !== input.expectedRevision) throw new ConflictException("La configuración cambió. Actualice antes de guardar");
        if (removals.some(group => !current || !(group === "certificate" ? current.certificateCipher : group === "sol" ? current.solUsernameCipher || current.solPasswordCipher : current.greClientIdCipher || current.greClientSecretCipher)))
          throw new BadRequestException("El grupo que desea retirar no está configurado");
        await recheckOwner();
        const row = await tx.sunatCredentials.upsert({ where,
          create: { issuerRuc: issuer.ruc, environment: issuer.environment, ...data, revision: 1 },
          update: { ...data, revision: { increment: 1 } },
        });
        await tx.fiscalConfigurationAudit.create({ data: { issuerRuc: issuer.ruc, environment: issuer.environment, actorId, fields, revision: row.revision } });
        await recheckOwner();
        return row;
      });
      return this.view(issuer, row);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("No se pudo guardar la configuración de forma segura");
    }
  }
}
