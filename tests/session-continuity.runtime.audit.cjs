// Sólo código instalado y respuesta no autenticada. No lee usuarios ni cookies.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const probe = `
const fs = require('node:fs');
const p = fs.readFileSync('/workspace/apps/web-pwa/features/workspace/provider.tsx', 'utf8');
const print = fs.readFileSync('/workspace/apps/web-pwa/features/workspace/pdf-print.tsx', 'utf8');
process.stdout.write(JSON.stringify({
  renderedProfileReference: p.includes('setSession(current => {') && p.includes('const previous = current?.user;'),
  freshTransportExpiry: p.includes('currentSession.current = { token: result.accessToken, user: result.user }') && p.includes('currentSession.current.user.exp * 1000'),
  backgroundVisibility: p.includes('void restoreSession().catch(() => {}).finally(check)'),
  permissionComparison: p.includes('previous.roles, previous.permissions, previous.scope'),
  noForcedReload: !p.includes('location.reload') && !p.includes('window.location ='),
  modalStillProtected: print.includes('await apiBlob(path') && print.includes('URL.revokeObjectURL') && print.includes('if (!user) setOpen(false)'),
  compiledApplication: fs.existsSync('/workspace/apps/web-pwa/.next/BUILD_ID')
}));`;
const result = JSON.parse(execFileSync('docker', ['exec', 'factuez-stage2-qa-web-pwa-1', 'node', '-e', probe],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 8192, windowsHide: true }));
for (const [key, value] of Object.entries(result)) assert.equal(value, true, key);
console.log(JSON.stringify({ ...result, result: 'PASS', readOnly: true }));
