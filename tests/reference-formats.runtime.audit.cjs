// Only installed source, flags and fictional in-memory PDF. Never reads DB or fiscal credentials.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const probe = `
  const fs = require('node:fs');
  const renderer = require('/workspace/packages/pdf-renderer/dist');
  const layout = fs.readFileSync('/workspace/packages/pdf-renderer/dist/layout.js', 'utf8');
  const sales = fs.readFileSync('/workspace/packages/pdf-renderer/dist/reference-sales.js', 'utf8');
  const guide = fs.readFileSync('/workspace/packages/pdf-renderer/dist/reference-guide.js', 'utf8');
  const sunat = process.argv[1] === 'sunat-service';
  const result = { service: process.argv[1],
    version4: renderer.PDF_RENDERER_VERSION === 'factuez.pdf-renderer.v4',
    measuredA4: layout.includes('595') && layout.includes('842') && layout.includes('Helvetica-Bold'),
    responsiveHeader: layout.includes('referenceHeader') && layout.includes('availableWidth') && layout.includes('inlineIssuer'),
    softTables: layout.includes('#c7cdd5') && layout.includes('#f6f7f9'),
    salesLayouts: sales.includes('Información Adicional') && sales.includes('Op. Exonerada') && sales.includes('IGV') && sales.includes('Factura/Boleta:'),
    guideLayouts: guide.includes('Datos del Remitente') && guide.includes('Datos del Vehículo y Conductor') && guide.includes('NO AUTORIZA TRASLADO'),
    noSampleData: !sales.includes('20175642341') && !guide.includes('20175642341') && !sales.includes('Bizlinks') && !guide.includes('Bizlinks'),
    gatesClosed: sunat ? process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'false' && process.env.SUNAT_BETA_WORKFLOW_ENABLED === 'false'
      : process.env.FACTUEZ_DEMO_SEED === 'false'
  };
  if (!Object.entries(result).every(([key, value]) => key === 'service' || value === true))
    throw new Error('Installed renderer or closed QA gates did not match');
  const samples = JSON.parse(fs.readFileSync(0, 'utf8'));
  (async () => {
    const generated = [];
    for (const sample of samples) {
      if (sample.snapshot.issuer.identityNumber !== '00000000000') throw new Error('Fictional issuer required');
      const bytes = await (sample.guide ? renderer.renderLocalTransportGuidePdf(sample.snapshot, 'a4')
        : renderer.renderLocalDocumentPdf(sample.snapshot, 'a4'));
      const pages = (bytes.toString('latin1').match(/\\/Type \\/Page\\b/g) || []).length;
      if (pages !== 1) throw new Error('Unexpected sample pagination');
      generated.push({ type: sample.type, bytes: bytes.length, pages });
    }
    process.stdout.write(JSON.stringify({ ...result, generated }));
  })().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;
async function main() {
  const { documentSample, guideSample } = await import('./qa-print-formats.mjs');
  const samples = ['01', '03', '07', '08'].map(type => ({ type, snapshot: documentSample(type) }));
  const receiptCredit = documentSample('07');
  receiptCredit.series = 'BQ00'; receiptCredit.fullNumber = 'BQ00-1';
  receiptCredit.reference.documentTypeCode = '03'; receiptCredit.reference.fullNumber = 'BQ00-2';
  samples.push({ type: '07-ref03', snapshot: receiptCredit });
  samples.push(...['09', '31'].map(type => ({ type, guide: true, snapshot: guideSample(type) })));
  for (const service of ['billing-service', 'sunat-service']) {
  const result = JSON.parse(execFileSync('docker', ['exec', '-i', `factuez-stage2-qa-${service}-1`, 'node', '-e', probe, service],
    { input: JSON.stringify(samples), encoding: 'utf8', timeout: 60000, maxBuffer: 8192, windowsHide: true }));
  for (const [key, value] of Object.entries(result)) if (!['service', 'generated'].includes(key)) assert.equal(value, true, `${service}: ${key}`);
  assert.equal(result.generated.length, 7);
  console.log(JSON.stringify({ ...result, result: 'PASS', readOnly: true }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
