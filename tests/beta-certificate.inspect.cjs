// Una sola identidad autorizada. Lectura local, sin firma, red SUNAT ni escritura fiscal.
const { readFileSync } = require('node:fs');
const { Client } = require('/workspace/services/sunat-service/node_modules/pg');
const { SecretVault } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/secret-vault');
const { inspectCertificate } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/certificate-inspector');
const { CertificateTrustService } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/certificate-trust.service');
const forge = require('/workspace/services/sunat-service/node_modules/node-forge');
const ruc = '20615878481', environment = 'BETA';
if (!process.argv.includes('--local-authorized') || process.env.SUNAT_ENVIRONMENT !== environment || process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== 'false') throw new Error('Sólo inspección local QA Beta');
const db = new Client({ host: process.env.DB_HOST, user: process.env.DB_USER, database: process.env.DB_NAME,
  password: readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
const buffers = [];
(async () => {
  await db.connect(); await db.query('BEGIN READ ONLY');
  const result = await db.query('SELECT revision, "certificateCipher", "certificatePasswordCipher", "certificateFingerprint" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]);
  if (result.rows.length !== 1) throw new Error();
  const row = result.rows[0], vault = new SecretVault();
  const bytes = vault.open(row.certificateCipher, { ruc, environment, field: 'certificate' }); buffers.push(bytes);
  const password = vault.open(row.certificatePasswordCipher, { ruc, environment, field: 'certificatePassword' }); buffers.push(password);
  const metadata = inspectCertificate(bytes, password.toString('utf8'));
  const trust = await new CertificateTrustService().evaluate(metadata, ruc);
  const publicCertificate = forge.pki.certificateFromPem(metadata.certificatePem);
  // Sólo formas/booleanos; nunca nombres personales, DNI ni valores de atributos.
  const identityAttributes = publicCertificate.subject.attributes
    .filter(attribute => ['2.5.4.5', '2.5.4.97'].includes(attribute.type))
    .map(attribute => ({ oid: attribute.type, exactTarget: String(attribute.value).trim() === ruc,
      targetEmbedded: new RegExp(`(?:^|\\D)${ruc}(?:\\D|$)`).test(String(attribute.value)),
      ntrPeTarget: String(attribute.value).trim() === `NTRPE-${ruc}`,
      form: String(attribute.value).replace(/[A-Za-zÀ-ÿ]/g, 'X').replace(/\d/g, '#').slice(0, 50) }));
  await db.query('COMMIT');
  console.log(JSON.stringify({ ruc, environment, revision: row.revision, validSigningPair: true,
    storedFingerprintMatches: metadata.fingerprint === row.certificateFingerprint, expiresAt: metadata.expiresAt,
    selfSigned: metadata.selfSigned, digitalSignature: metadata.digitalSignature,
    exactRucMatch: trust.identityMatched, chainVerified: trust.chainValid, revocation: trust.revocation,
    blockers: trust.blockers, rucCandidatesCount: metadata.subjectRucCandidates.length, identityAttributes,
    signaturesCreated: 0, officialRequests: 0, fiscalWrites: 0 }));
})().catch(() => { console.error('Inspección local no completada; revise el certificado en la interfaz. No se muestran secretos.'); process.exitCode = 1; })
  .finally(async () => { for (const bytes of buffers) bytes.fill(0); await db.end().catch(() => {}); });
