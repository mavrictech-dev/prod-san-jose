import "reflect-metadata";
import { createRequire } from "node:module";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretVault } from "../services/sunat-service/src/infrastructure/crypto/secret-vault";
import { inspectCertificate, MAX_CERTIFICATE_BYTES } from "../services/sunat-service/src/infrastructure/crypto/certificate-inspector";
import { ConfigurationGuard } from "../services/sunat-service/src/auth/configuration.guard";
import { FiscalConfigurationService } from "../services/sunat-service/src/application/fiscal-configuration.service";
const serviceRequire = createRequire(new URL("../services/sunat-service/package.json", import.meta.url));
const forge: typeof import("../services/sunat-service/node_modules/node-forge") = serviceRequire("node-forge");
let key: ReturnType<typeof forge.pki.privateKeyFromPem>;
let publicKey: ReturnType<typeof forge.pki.publicKeyFromPem>;
const password = "Only-QA-PKCS12";
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  key = forge.pki.privateKeyFromPem(pair.privateKey); publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
});
function p12(options: { expired?: boolean; future?: boolean; noKey?: boolean; noSignature?: boolean; reverseChain?: boolean } = {}) {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey; certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() + (options.future ? 86400000 : -86400000));
  certificate.validity.notAfter = new Date(Date.now() + (options.expired ? -3600000 : 86400000 * 30));
  certificate.setSubject([{ name: "commonName", value: "CERTIFICADO FICTICIO QA" }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: !options.noSignature }]);
  certificate.sign(key, forge.md.sha256.create());
  const chain = forge.pki.createCertificate();
  chain.publicKey = publicKey; chain.serialNumber = "02";
  chain.validity.notBefore = certificate.validity.notBefore; chain.validity.notAfter = certificate.validity.notAfter;
  chain.setSubject([{ name: "commonName", value: "CA FICTICIA QA" }]); chain.setIssuer(chain.subject.attributes);
  chain.setExtensions([{ name: "basicConstraints", cA: true }]); chain.sign(key, forge.md.sha256.create());
  // La CA lleva otra clave pública: certificado de CA al inicio no debe elegirse.
  const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" } });
  chain.publicKey = forge.pki.publicKeyFromPem(other.publicKey); chain.sign(key, forge.md.sha256.create());
  const asn = forge.pkcs12.toPkcs12Asn1(options.noKey ? null : key, options.reverseChain ? [chain, certificate] : certificate, password, { algorithm: "aes256" });
  return Buffer.from(forge.asn1.toDer(asn).getBytes(), "binary");
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("bóveda por RUC/ambiente/campo", () => {
  it("cifra con nonce aleatorio, autentica contexto y detecta manipulación", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factuez-vault-"));
    try {
      const path = join(directory, "key"); await writeFile(path, randomBytes(32).toString("base64url"), { mode: 0o600 });
      vi.stubEnv("APP_MASTER_KEY_FILE", path);
      const vault = new SecretVault(); const context = { ruc: "00000000000", environment: "BETA", field: "solPassword" };
      const one = vault.seal("Secret-QA", context); const two = vault.seal("Secret-QA", context);
      expect(one).not.toBe(two); expect(one).not.toContain("Secret-QA"); expect(vault.open(one, context).toString()).toBe("Secret-QA");
      for (const altered of [{ ...context, ruc: "11111111111" }, { ...context, environment: "PRODUCTION" }, { ...context, field: "certificate" }])
        expect(() => vault.open(one, altered)).toThrow("verificar");
      expect(() => vault.open(one.slice(0, -3) + "AAA", context)).toThrow("verificar");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("falla cerrado sin clave, sin incluir ruta ni contenidos en el error", () => {
    vi.stubEnv("APP_MASTER_KEY_FILE", "");
    expect(() => new SecretVault().seal("QA", { ruc: "0", environment: "BETA", field: "test" })).toThrow("bóveda");
  });
});
describe("PKCS#12", () => {
  it("verifica par RSA, vigencia, huella y no confunde CA al inicio", () => {
    const metadata = inspectCertificate(p12({ reverseChain: true }), password);
    expect(metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(metadata.selfSigned).toBe(true);
  });
  it.each([{ expired: true }, { future: true }, { noKey: true }, { noSignature: true }])("rechaza certificado no utilizable %j", options => {
    expect(() => inspectCertificate(p12(options), password)).toThrow("PKCS#12 inválido");
  });
  it("rechaza contraseña errónea y límite de tamaño sin revelar secretos", () => {
    expect(() => inspectCertificate(p12(), "Secret-Wrong-QA")).toThrow("PKCS#12 inválido");
    expect(() => inspectCertificate(Buffer.alloc(MAX_CERTIFICATE_BYTES + 1), password)).toThrow("512 KB");
  });
});
const admin = { sub: "50000000-0000-4000-8000-000000000009", roles: ["ADMIN"], permissions: ["sunat.configure"], scope: { kind: "GLOBAL" } };
function context() {
  const request = { headers: { authorization: "Bearer QA.token" } };
  return { request, execution: { switchToHttp: () => ({ getRequest: () => request }) } as never };
}
describe("configuración sólo administrador vigente", () => {
  it("verifica Identity y no confía en permisos aportados por cliente", async () => {
    const f = context(); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(admin))));
    expect(await new ConfigurationGuard().canActivate(f.execution)).toBe(true);
    expect(f.request).toHaveProperty("user.sub", admin.sub);
  });
  it.each([401, 403, 503])("falla cerrado si Identity responde %s", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
    await expect(new ConfigurationGuard().canActivate(context().execution)).rejects.toThrow();
  });
  it("rechaza jefe de sede aunque reciba permiso de configuración", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...admin, roles: ["STATION_MANAGER"], scope: { kind: "ASSIGNED", branchIds: [], emissionPointIds: [], series: [] } }))));
    await expect(new ConfigurationGuard().canActivate(context().execution)).rejects.toThrow("administrador general");
  });
  it("rechaza sin bearer y fallo de red", async () => {
    const f = context(); f.request.headers.authorization = "";
    await expect(new ConfigurationGuard().canActivate(f.execution)).rejects.toThrow("Inicie sesión");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(new ConfigurationGuard().canActivate(context().execution)).rejects.toThrow("identidad");
  });
});
function serviceFixture() {
  let row: any = null;
  const findUnique = vi.fn(async () => row);
  const upsert = vi.fn(async (args: any) => row = { ...row, ...(!row ? args.create : args.update), revision: !row ? 1 : row.revision + 1, updatedAt: new Date() });
  const audit = vi.fn(async () => ({}));
  const tx = { sunatCredentials: { findUnique, upsert }, fiscalConfigurationAudit: { create: audit }, $executeRaw: vi.fn() };
  const transaction = vi.fn(async (callback: any) => callback(tx));
  const seal = vi.fn((value: string | Buffer, context: unknown) => `cipher:${JSON.stringify(context)}`);
  const service = new FiscalConfigurationService({ ...tx, $transaction: transaction } as never, { seal } as never, { inspect: async (bytes: Buffer, password: string) => inspectCertificate(bytes, password) } as never);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ companies: [{ id: 1, ruc: "00000000000" }] }))));
  return { service, audit, transaction, upsert, seal };
}
describe("configuración por emisor sin transmisión", () => {
  it("retira SOL preservando GRE, revisión y auditoría sin revelar secretos", async () => {
    const f = serviceFixture();
    await f.service.save("1", "BETA", { expectedRevision: 0, sol: { username: "QAUSER", password: "ONLY-QA" }, gre: { clientId: "QA", clientSecret: "ONLY-QA-GRE" } }, "Bearer QA.token", admin.sub);
    const result = await f.service.save("1", "BETA", { expectedRevision: 1, remove: ["sol"] }, "Bearer QA.token", admin.sub);
    expect(result).toMatchObject({ revision: 2, solConfigured: false, greConfigured: true, fiscalTransmission: false });
    expect(f.upsert.mock.calls[1][0].update).toMatchObject({ solUsernameCipher: null, solPasswordCipher: null });
    expect(f.audit.mock.calls[1][0].data.fields).toEqual(["sol.remove"]);
    expect(JSON.stringify(result)).not.toContain("ONLY-QA");
    await expect(f.service.save("1", "BETA", { expectedRevision: 1, remove: ["gre"] }, "Bearer QA.token", admin.sub)).rejects.toThrow("cambió");
    await expect(f.service.save("1", "BETA", { expectedRevision: 2, remove: ["sol"] }, "Bearer QA.token", admin.sub)).rejects.toThrow("no está configurado");
  });
  it("retira certificado y metadatos sin borrar registro ni historial", async () => {
    const f = serviceFixture();
    await f.service.save("1", "BETA", { expectedRevision: 0, certificate: { fileName: "QA.p12", base64: p12().toString("base64"), password } }, "Bearer QA.token", admin.sub);
    const result = await f.service.save("1", "BETA", { expectedRevision: 1, remove: ["certificate"] }, "Bearer QA.token", admin.sub);
    expect(result.certificate).toMatchObject({ configured: false, fingerprint: null, expiresAt: null, selfSigned: null });
    expect(f.upsert.mock.calls[1][0].update).toMatchObject({ certificatePasswordCipher: null, certificateCipher: null, certificateStorageKey: null });
    expect(result.revision).toBe(2);
  });
  it.each([[], ["invalid"], ["sol", "sol"], "sol", null])("rechaza retiros inválidos %j", async remove => {
    const f = serviceFixture();
    await expect(f.service.save("1", "BETA", { expectedRevision: 0, remove } as never, "Bearer QA.token", admin.sub)).rejects.toThrow();
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it("rechaza retirar y reemplazar un grupo en la misma solicitud", async () => {
    const f = serviceFixture();
    await expect(f.service.save("1", "BETA", { expectedRevision: 0, remove: ["sol"], sol: { username: "QAUSER", password: "ONLY-QA" } }, "Bearer QA.token", admin.sub)).rejects.toThrow("mismo grupo");
    expect(f.seal).not.toHaveBeenCalled();
  });
  it("audita sólo metadatos del RUC y ambiente autorizado con paginado", async () => {
    const count = vi.fn(async () => 11), findMany = vi.fn(async () => []);
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const service = new FiscalConfigurationService({ fiscalConfigurationAudit: { count, findMany }, $transaction: transaction } as never, {} as never, {} as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ companies: [{ id: 1, ruc: "00000000000" }] }))));
    expect(await service.audit("1", "BETA", "Bearer QA", "2")).toMatchObject({ total: 11, page: 2, pageSize: 10 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { issuerRuc: "00000000000", environment: "BETA" }, skip: 10, take: 10 });
    expect(Object.keys(findMany.mock.calls[0][0].select).sort()).toEqual(["actorId", "fields", "id", "occurredAt", "revision"]);
    await expect(service.audit("1", "BETA", "Bearer QA", "0")).rejects.toThrow("Página inválida");
  });
  it("valida y cifra el PKCS#12 completo sin devolver su contenido", async () => {
    const f = serviceFixture();
    const bytes = p12();
    const view = await f.service.save("1", "BETA", { expectedRevision: 0, certificate: { fileName: "QA.pfx", base64: bytes.toString("base64"), password } }, "Bearer QA.token", admin.sub);
    expect(view.certificate).toMatchObject({ configured: true, selfSigned: true, trustAndRucVerified: false });
    expect(f.audit.mock.calls[0][0].data.fields).toEqual(["certificate"]);
    expect(JSON.stringify(view)).not.toContain(password);
    expect(JSON.stringify(view)).not.toContain(bytes.toString("base64"));
  });
  it("guarda cifrado, audita sólo campos y omite secretos en la respuesta", async () => {
    const f = serviceFixture();
    const input = { expectedRevision: 0, sol: { username: "QAUSER", password: "Only-QA-SOL" }, gre: { clientId: "QA-CLIENT", clientSecret: "Only-QA-GRE" } };
    const view = await f.service.save("1", "BETA", input, "Bearer QA.token", admin.sub);
    expect(view).toMatchObject({ ruc: "00000000000", revision: 1, solConfigured: true, greConfigured: true, fiscalTransmission: false });
    expect(JSON.stringify(view)).not.toMatch(/Only-QA|Cipher|StorageKey/);
    expect(f.audit.mock.calls[0][0].data).toMatchObject({ actorId: admin.sub, fields: ["sol", "gre"], revision: 1 });
    expect(f.seal.mock.calls[0][1]).toEqual({ ruc: "00000000000", environment: "BETA", field: "solUsername" });
    await expect(f.service.save("1", "BETA", input, "Bearer QA.token", admin.sub)).rejects.toThrow("configuración cambió");
    expect(f.upsert).toHaveBeenCalledOnce();
  });
  it("no guarda configuración vacía, incompleta o campos de activación", async () => {
    const f = serviceFixture();
    for (const input of [{ expectedRevision: 0 }, { expectedRevision: 0, sol: { username: "QA" } }, { expectedRevision: 0, fiscalTransmission: true }])
      await expect(f.service.save("1", "BETA", input as never, "Bearer QA.token", admin.sub)).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("no usa un RUC arbitrario ni fallback de credenciales entre ambientes", async () => {
    const f = serviceFixture();
    await expect(f.service.status("99", "BETA", "Bearer QA.token")).rejects.toThrow("Emisor no disponible");
    await expect(f.service.status("1", "QA", "Bearer QA.token")).rejects.toThrow("ambiente inválido");
    const view = await f.service.status("1", "PRODUCTION", "Bearer QA.token");
    expect(view).toMatchObject({ environment: "PRODUCTION", revision: 0, solConfigured: false, greConfigured: false, fiscalTransmission: false });
  });
});
