import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/sunat-service/node_modules/@nestjs/core';
import { GuideArtifactApi } from '../services/sunat-service/src/application/guide-artifact-api';
import { GuideArtifactModule } from '../services/sunat-service/src/guide-artifact-http';
import { B2bGuideArtifacts, B2bGuideArtifactModule, HttpB2bGuideArtifactOwner } from '../services/b2b-api-service/src/guide-artifacts';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { createGuideSidecarPki, guideSidecarCdrXml, guideSidecarPackCdr } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { guideArtifactFixture } from './helpers/guide-artifact.fixture';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';

describe('consumer HTTPS → B2B facade → private mTLS SUNAT artifact owner', () => {
  let tls: ReturnType<typeof b2bCertificates>, pki: ReturnType<typeof createGuideSidecarPki>, ownerApp: any, app: any, port: number;
  let f: Awaited<ReturnType<typeof guideArtifactFixture>>, api: GuideArtifactApi;
  const identity = { authenticate: vi.fn(async () => {
    const a = f.f.proof.actor.b2b!;
    return { ...a, environment: 'BETA' as const, scopes: ['b2b:documents:read','b2b:guides:issue','b2b:guides:read','b2b:guide-operations:read'], bindings: [f.scope.binding.draft.anchor] } as any;
  }) };
  beforeEach(async () => { f = await guideArtifactFixture(pki); api = new GuideArtifactApi(f.core); identity.authenticate.mockClear(); });
  beforeAll(async () => {
    tls = b2bCertificates(); pki = createGuideSidecarPki('20000000001');
    const httpsOptions = { ca: tls.ca, cert: tls.server, key: tls.key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    ownerApp = await NestFactory.create(GuideArtifactModule.isolated({
      view: (...args: Parameters<GuideArtifactApi['view']>) => api.view(...args),
      content: (...args: Parameters<GuideArtifactApi['content']>) => api.content(...args),
    } as GuideArtifactApi, [fingerprint(tls.resource)]), { logger: false, bodyParser: false, httpsOptions });
    ownerApp.useBodyParser('json', { limit: 32768, strict: true }); await ownerApp.listen(0,'127.0.0.1');
    const ownerPort = (ownerApp.getHttpServer().address() as AddressInfo).port;
    const transport = new B2bPrivateHttp(`https://127.0.0.1:${ownerPort}`, { ca: tls.ca, cert: tls.resource, key: tls.key });
    const facade = new B2bGuideArtifacts(identity, new HttpB2bGuideArtifactOwner(transport));
    app = await NestFactory.create(B2bGuideArtifactModule.isolated(facade,[fingerprint(tls.edge)]), { logger: false, bodyParser: false, httpsOptions });
    app.useBodyParser('json', { limit: 16384, strict: true }); await app.listen(0,'127.0.0.1'); port = (app.getHttpServer().address() as AddressInfo).port;
  },30000);
  afterAll(async () => { await app?.close(); await ownerApp?.close(); });
  const base = () => `/b2b/v1/guide-drafts/${f.scope.draftId}/issuances/${f.scope.operationId}/artifacts`;
  const query = () => {
    const b = f.scope.binding, a = b.draft.anchor;
    return '?' + new URLSearchParams(Object.entries({ ...a, guideSeriesId: b.draft.guideSeriesId, guideType: b.draft.guideType, fiscalSeriesId: b.fiscalSeriesId }).map(([k,v]) => [k,String(v)])).toString();
  };
  function send(method: string, path: string, body?: unknown, peer: 'edge' | 'other' = 'edge', headers: Record<string,string> = {}) {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<{ status: number; body: any; bytes: Buffer; headers: any }>((resolve,reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, ca: tls.ca, cert: tls[peer], key: tls.key, rejectUnauthorized: true,
        headers: { Authorization: 'Bearer synthetic-artifact-access', 'X-FactuEz-Actor-Kind':'SERVICE', ...(data ? { 'Content-Type':'application/json','Content-Length':String(data.length) } : {}), ...headers } }, res => {
        const parts: Buffer[] = []; res.on('data', p => parts.push(p)); res.on('end', () => {
          const bytes = Buffer.concat(parts); resolve({ status: res.statusCode!, bytes, headers: res.headers,
            body: String(res.headers['content-type']).startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : null });
        });
      }); req.on('error',reject); req.end(data);
    });
  }
  const prepare = () => send('POST',base(),{ binding: f.scope.binding });
  it('prepares once and downloads exact signed XML/ZIP with no key or storage leakage', async () => {
    const r = await prepare(); expect(r.status).toBe(200); expect(r.body.replayed).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|pkcs12|password|synthetic-artifact-access|keySha256|requestSha256/);
    expect((await prepare()).body.replayed).toBe(true); expect(f.signer.sign).toHaveBeenCalledTimes(1);
    const view = await send('GET',base()+query()); expect(view.status).toBe(200); expect(view.body.replayed).toBeNull();
    for (const type of ['xml','zip']) {
      const r = await send('GET',base()+'/'+type+query()); expect(r.status).toBe(200);
      expect(r.bytes).toEqual(type === 'xml' ? Buffer.from(f.state.artifact!.signedXml) : f.state.artifact!.zip);
      expect(r.headers['x-content-sha256']).toBe(type === 'xml' ? view.body.metadata.xmlSha256 : view.body.metadata.zipSha256);
      expect(r.headers['cache-control']).toBe('private, no-store'); expect(r.headers['x-factuez-source']).toBe('LOCAL_EMULATOR');
    }
    expect(f.f.state().next).toBe(2);
  });
  it('downloads only the captured cryptographically reviewed CDR, never a fabricated replacement', async () => {
    await prepare(); expect((await send('GET',base()+'/cdr-zip'+query())).status).toBe(404);
    const m = f.state.artifact!.metadata, expected = { issuerRuc: m.issuerRuc, documentType: '09' as const, fullNumber: m.fullNumber,
      requestXmlSha256: m.xmlSha256, requestZipSha256: m.zipSha256, issuedAt: '2026-10-21T15:30:00.000Z', receivedAt: '2026-10-23T16:00:00.000Z' };
    const xml = pki.signCdr(guideSidecarCdrXml(expected)), zip = guideSidecarPackCdr(xml,expected);
    await f.core.reviewCdr(f.scope,f.access,zip);
    expect((await send('GET',base()+'/cdr-zip'+query())).bytes).toEqual(zip);
    expect((await send('GET',base()+'/cdr-xml'+query())).bytes).toEqual(Buffer.from(xml));
  });
  it('GET does not prepare or sign a missing artifact', async () => {
    expect((await send('GET',base()+query())).status).toBe(404); expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it('rejects a different trusted TLS peer before authorization or key use', async () => {
    const r = await send('POST',base(),{ binding: f.scope.binding },'other'); expect(r.status).toBe(403);
    expect(identity.authenticate).not.toHaveBeenCalled(); expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it.each(['duplicate-query','query-alias','query-extra','foreign-series','body-on-get','invalid-artifact'])('rejects %s without signing', async scenario => {
    let path = base()+query();
    if (scenario === 'duplicate-query') path += '&issuerId=1';
    if (scenario === 'query-alias') path = path.replace('issuerId=','issuer_id=');
    if (scenario === 'query-extra') path += '&accepted=true';
    if (scenario === 'foreign-series') path = path.replace(f.scope.binding.fiscalSeriesId,'00000000-0000-4000-8000-000000009999');
    if (scenario === 'invalid-artifact') path = base()+'/p12'+query();
    const r = await send('GET',path,scenario === 'body-on-get' ? {} : undefined);
    expect([400,404,503]).toContain(r.status); expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it('does not accept request certificate paths, uploaded XML or accepted flags', async () => {
    const r = await send('POST',base(),{ binding: f.scope.binding, xml:'fake', accepted:true, certificatePath:'fake.p12' });
    expect(r.status).toBe(400); expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it('revoked owner cannot return old cached bytes', async () => {
    await prepare(); f.control.revoked = true;
    const r = await send('GET',base()+'/xml'+query()); expect(r.status).toBe(503); expect(r.bytes.toString()).not.toContain('SignatureValue');
  });
});
