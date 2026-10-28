import { createHash } from 'node:crypto';
import { guideArtifactWireView, guideArtifactWireFile, guideArtifactWireScope, type GuideArtifactKind } from '@factuez/service-access/dist/b2b-guide-artifact-wire';
import { GuideArtifactPipeline } from './guide-artifact-pipeline';
import type { GuideArtifactAccess } from './guide-artifact-owner';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';

/** This owner remains the only reader of original bytes. A GET never signs or
 * reserves; preparation requires the independent ISSUE authority in the pipeline. */
export class GuideArtifactApi {
  constructor(private readonly pipeline: GuideArtifactPipeline) {}
  async view(input: unknown, access: GuideArtifactAccess, prepare = false) {
    const scope = guideArtifactWireScope(input), r = prepare ? await this.pipeline.prepare(scope, access) : await this.pipeline.read(scope, access);
    return guideArtifactWireView({ schemaVersion: 'factuez.b2b.guide-artifacts.v1', scope,
      metadata: r.record.metadata, replayed: prepare ? r.replayed : null }, scope, prepare);
  }
  async content(input: unknown, access: GuideArtifactAccess, kind: GuideArtifactKind) {
    const scope = guideArtifactWireScope(input), r = await this.pipeline.read(scope, access);
    const view = guideArtifactWireView({ schemaVersion: 'factuez.b2b.guide-artifacts.v1', scope, metadata: r.record.metadata, replayed: null }, scope, false);
    const m = view.metadata, xml = kind === 'xml' || kind === 'cdr-xml', cdr = kind.startsWith('cdr-');
    let bytes: Buffer;
    if (cdr) {
      const a = await this.pipeline.readCdr(scope, access);
      bytes = xml ? parseCdrZip(a.zip, { issuerRuc: m.issuerRuc, reference: m.fullNumber,
        fileName: `R-${m.issuerRuc}-${m.guideType}-${m.fullNumber}.xml` }).xml : a.zip;
    } else bytes = xml ? Buffer.from(r.record.signedXml) : Buffer.from(r.record.zip);
    return guideArtifactWireFile({ bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: xml ? 'application/xml' : 'application/zip',
      fileName: `${cdr ? 'R-' : ''}${m.issuerRuc}-${m.guideType}-${m.fullNumber}.${xml ? 'xml' : 'zip'}` }, view, kind);
  }
}
