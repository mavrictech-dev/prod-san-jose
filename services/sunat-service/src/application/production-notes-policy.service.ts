import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE, type FiscalDocumentSnapshot, type ProductionNotesAnySnapshot as ProductionNotesSnapshot, type ProductionNotesAnyAdmission as ProductionNotesAdmission } from '@factuez/contracts';
import { assertProductionNotesAnySnapshot as assertProductionNotesSnapshot, signProductionNotesOwner, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import { FiscalConfigurationService } from './fiscal-configuration.service';
import { FiscalReadinessService } from './fiscal-readiness.service';
import { ProductionNotesEvidenceService } from './production-notes-evidence.service';
export const PRODUCTION_NOTES_CONFIRMATION = 'AUTORIZAR NOTAS REALES 07 Y 08 SOBRE FACTURA 01';
export const PRODUCTION_NOTES_EXTENDED_CONFIRMATION = 'AUTORIZAR NOTAS REALES 07 Y 08 SOBRE FACTURAS Y BOLETAS';
const profiles = [PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE];
const supportedReasons = (profile: string) => profile === PRODUCTION_NOTES_PROFILE ? { '07': ['01'], '08': ['02'] } : { '07': ['01','02','03','04','05','06','07','08','09','10'], '08': ['01','02','03'] };
const allowsProfile = (grant: string, note: string) => profiles.includes(note as typeof PRODUCTION_NOTES_PROFILE) && (grant === note || grant === PRODUCTION_NOTES_EXTENDED_PROFILE && note === PRODUCTION_NOTES_PROFILE);
export const productionNotesEnabled = () => process.env.SUNAT_PRODUCTION_NOTES_ENABLED === 'true' && process.env.SUNAT_PRODUCTION_WORKFLOW_ENABLED === 'true';
export type ProductionNotesGrant = {
    issuerRuc: string;
    enabled: boolean;
    version: number;
    credentialRevision: number;
    fingerprint: string;
    profile: string;
};
@Injectable()
export class ProductionNotesPolicyService {
    constructor(private readonly prisma: PrismaService, private readonly configuration: FiscalConfigurationService, private readonly readiness: FiscalReadinessService, private readonly evidence: ProductionNotesEvidenceService) { }
    async grant(ruc: string) { const rows = await this.prisma.$queryRawUnsafe<ProductionNotesGrant[]>('SELECT * FROM "ProductionNotesGrant" WHERE "issuerRuc"=$1', ruc); return rows[0]; }
    async status(companyId: string, authorization: string) {
        const config = await this.configuration.status(companyId, 'PRODUCTION', authorization), grant = await this.grant(config.ruc);
        const profile=grant?.profile??PRODUCTION_NOTES_PROFILE;
        return { profile, issuerRuc: config.ruc, version: grant?.version ?? 0, credentialRevision: config.revision,
            availableProfiles: [{profile:PRODUCTION_NOTES_PROFILE,confirmation:PRODUCTION_NOTES_CONFIRMATION,originalTypes:['01'],supportedReasons:supportedReasons(PRODUCTION_NOTES_PROFILE)},
                {profile:PRODUCTION_NOTES_EXTENDED_PROFILE,confirmation:PRODUCTION_NOTES_EXTENDED_CONFIRMATION,originalTypes:['01','03'],supportedReasons:supportedReasons(PRODUCTION_NOTES_EXTENDED_PROFILE)}],
            supportedDocumentTypes: ['07', '08'], supportedReasons:supportedReasons(profile), originalTypes:profile===PRODUCTION_NOTES_PROFILE?['01']:['01','03'], serverEnabled: productionNotesEnabled(),
            enabled: productionNotesEnabled() && profiles.includes(profile as typeof PRODUCTION_NOTES_PROFILE) && grant?.enabled === true && grant.credentialRevision === config.revision && grant.fingerprint === config.certificate.fingerprint };
    }
    async configure(companyId: string, input: unknown, authorization: string, actorId: string) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new BadRequestException('Solicitud inválida');
        const v = input as Record<string, unknown>;
        if (Object.keys(v).some(k => !['enabled', 'expectedVersion', 'expectedRevision', 'authorizedDocumentTypes', 'confirmation', 'profile'].includes(k)) || typeof v.enabled !== 'boolean' || !Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 0 || !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 0)
            throw new BadRequestException('Solicitud inválida');
        const config = await this.configuration.status(companyId, 'PRODUCTION', authorization);
        const previous=await this.grant(config.ruc), profile=v.profile??(v.enabled?PRODUCTION_NOTES_PROFILE:previous?.profile??PRODUCTION_NOTES_PROFILE);
        if(typeof profile!=='string'||!profiles.includes(profile as typeof PRODUCTION_NOTES_PROFILE))throw new BadRequestException('Perfil de notas no admitido');
        if (config.revision !== v.expectedRevision)
            throw new ConflictException('Credenciales cambiaron');
        if (v.enabled) {
            if (!productionNotesEnabled() || config.emissionEnvironment !== 'PRODUCTION' || v.confirmation !== (profile===PRODUCTION_NOTES_PROFILE?PRODUCTION_NOTES_CONFIRMATION:PRODUCTION_NOTES_EXTENDED_CONFIRMATION) || JSON.stringify(v.authorizedDocumentTypes) !== '["07","08"]')
                throw new BadRequestException('Confirme explícitamente el perfil nuevo de notas 07/08');
            signProductionNotesOwner({ issuerRuc: config.ruc, profile }, 'admission'); // Required private owner boundary must exist before enablement.
            const report = await this.readiness.inspect(companyId, 'PRODUCTION', authorization);
            const required = ['ISSUER_REAL_RUC', 'SECRET_VAULT', 'SOL_SECRETS_LOCAL', 'CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'CERTIFICATE_CHAIN', 'CERTIFICATE_REVOCATION', 'XSD_RUNTIME', 'CDR_TRUST'];
            if (report.revision !== config.revision || required.some(code => !report.checks.some(c => c.code === code && c.status === 'PASS')))
                throw new BadRequestException('Verificaciones fiscales pendientes');
        }
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'production-notes-grant:' + config.ruc);
            const rows = await tx.$queryRawUnsafe<ProductionNotesGrant[]>('SELECT * FROM "ProductionNotesGrant" WHERE "issuerRuc"=$1 FOR UPDATE', config.ruc);
            if ((rows[0]?.version ?? 0) !== v.expectedVersion)
                throw new ConflictException('Autorización cambió');
            const creds = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: config.ruc, environment: 'PRODUCTION' } } });
            if ((creds?.revision ?? 0) !== v.expectedRevision || v.enabled && creds?.certificateFingerprint !== config.certificate.fingerprint)
                throw new ConflictException('Credenciales cambiaron');
            await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesGrant" ("issuerRuc","profile","enabled","version","credentialRevision","fingerprint","actorId") VALUES ($1,$2,$3,$4,$5,$6,$7::uuid) ON CONFLICT ("issuerRuc") DO UPDATE SET "profile"=EXCLUDED."profile","enabled"=EXCLUDED."enabled","version"=EXCLUDED."version","credentialRevision"=EXCLUDED."credentialRevision","fingerprint"=EXCLUDED."fingerprint","actorId"=EXCLUDED."actorId","updatedAt"=now()', config.ruc, profile, v.enabled, Number(v.expectedVersion) + 1, config.revision, config.certificate.fingerprint ?? '0'.repeat(64), actorId);
            await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesGrantAudit" ("id","issuerRuc","version","enabled","actorId","profile") VALUES (gen_random_uuid(),$1,$2,$3,$4::uuid,$5)', config.ruc, Number(v.expectedVersion) + 1, v.enabled, actorId, profile);
        });
        return this.status(companyId, authorization);
    }
    async current(ruc: string, expected?: ProductionNotesAdmission) {
        if (!productionNotesEnabled())
            throw Error('Notas productivas deshabilitadas');
        const grant = await this.grant(ruc), credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: ruc, environment: 'PRODUCTION' } } });
        if (!grant?.enabled || !profiles.includes(grant.profile as typeof PRODUCTION_NOTES_PROFILE) || !credentials || grant.credentialRevision !== credentials.revision || grant.fingerprint !== credentials.certificateFingerprint || credentials.certificateSelfSigned !== false || !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() ||
            expected && (!allowsProfile(grant.profile,expected.profile) || grant.version !== expected.grantVersion || credentials.revision !== expected.credentialRevision || grant.fingerprint !== expected.certificateFingerprint))
            throw Error('Autorización de notas revocada, ajena o desactualizada');
        return { grant, credentials };
    }
    async admit(note: ProductionNotesSnapshot, original: FiscalDocumentSnapshot, history: ProductionNotesSnapshot[]): Promise<ProductionNotesAdmission> {
        assertProductionNotesSnapshot(note, original, history);
        const { grant, credentials } = await this.current(note.issuer.identityNumber);
        if(!allowsProfile(grant.profile,note.profile))throw Error('El perfil autorizado no incluye estos motivos o tipo de original');
        const fresh = await this.evidence.original(original), frozen = note.originalAcceptance;
        if(fiscalSnapshotSha256({...fresh,checkedAt:undefined})!==fiscalSnapshotSha256({...frozen,checkedAt:undefined}))throw Error('La aceptación original o el vínculo RC cambió');
        for (const key of ['documentId', 'snapshotSha256', 'signedXmlSha256', 'cdrXmlSha256', 'cdrZipSha256', 'acceptedAt'] as const)
            if (fresh[key] !== frozen[key])
                throw Error('Evidencia original cambió');
        await this.current(note.issuer.identityNumber, { authorized: true, profile: note.profile, snapshotSha256: fiscalSnapshotSha256(note), grantVersion: grant.version, credentialRevision: credentials.revision, certificateFingerprint: grant.fingerprint });
        return { authorized: true, profile: note.profile, snapshotSha256: fiscalSnapshotSha256(note), grantVersion: grant.version, credentialRevision: credentials.revision, certificateFingerprint: grant.fingerprint };
    }
}
