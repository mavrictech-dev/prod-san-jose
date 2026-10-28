// Sólo metadatos y código del renderer instalado en los dos servicios QA.
// No consulta BD, comprobantes, logos personalizados, certificados ni secretos.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');

const probe = `
  const fs = require('node:fs');
  const code = fs.readFileSync('/workspace/packages/pdf-renderer/dist/layout.js', 'utf8');
  const sunat = process.argv[1] === 'sunat-service';
  process.stdout.write(JSON.stringify({
    service: process.argv[1],
    whiteBackgroundAndGrayBorder: code.includes("fillAndStroke('#ffffff', '#b7b7b7')"),
    thinBorder: code.includes('lineWidth(0.8)'),
    darkText: code.includes("options.color ?? '#191919'") && !code.includes("color: '#ffffff'"),
    oldBlackBoxAbsent: !code.includes("fill('#151515')"),
    printEnabled: process.env.PRINT_SETTINGS_ENABLED === 'true',
    gatesClosed: sunat
      ? process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'false' && process.env.SUNAT_BETA_WORKFLOW_ENABLED === 'false'
      : process.env.FACTUEZ_DEMO_SEED === 'false'
  }));
`;
for (const service of ['billing-service', 'sunat-service']) {
  const output = execFileSync('docker', ['exec', `factuez-stage2-qa-${service}-1`, 'node', '-e', probe, service],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 8192, windowsHide: true });
  const result = JSON.parse(output);
  assert.equal(result.service, service);
  for (const key of ['whiteBackgroundAndGrayBorder', 'thinBorder', 'darkText', 'oldBlackBoxAbsent', 'printEnabled', 'gatesClosed'])
    assert.equal(result[key], true, `${service}: ${key}`);
  console.log(JSON.stringify({ ...result, result: 'PASS', readOnly: true }));
}
