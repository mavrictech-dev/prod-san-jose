import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditInventory, inspectSource, validateInventory } from '../migration/integration-source-audit.mjs';
const inventory = JSON.parse(await readFile(new URL('../api-contracts/integration/phase1-inventory.v1.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(inventory);

test('inventory covers all six types without claiming a deployed API', () => {
  assert.equal(validateInventory(inventory), inventory);
  assert.equal(inventory.scope.phase2EndpointsImplemented, false);
  assert.equal(inventory.scope.remoteAccessEnabled, false);
});
test('runtime or fiscal actions cannot be claimed as source-only audit', () => {
  for (const key of ['runtimeDataRead', 'secretsRead', 'officialNetworkUsed', 'deploymentsChanged']) {
    const bad = copy(); bad.scope[key] = true;
    assert.throws(() => validateInventory(bad), /SOURCE_ONLY_SCOPE_REQUIRED/);
  }
});
test('secret paths, generated content and arbitrary filesystem paths are refused', () => {
  for (const path of ['../other.ts', 'C:/secrets/key.ts', 'services/sunat-service/secrets/key.ts',
    'services/sunat-service/src/generated/prisma/client.ts', 'services/identity-service/.env',
    'services/sunat-service/src/../../secrets.ts']) {
    const bad = copy(); bad.sources[0].path = path;
    assert.throws(() => validateInventory(bad), /SOURCE_PATH_INVALID/);
  }
});
test('missing document type or broken evidence cannot silently pass', () => {
  const missing = copy(); missing.documents.pop();
  assert.throws(() => validateInventory(missing), /SIX_DOCUMENT_TYPES_REQUIRED/);
  const broken = copy(); broken.documents[0].evidence = ['nonexistent'];
  assert.throws(() => validateInventory(broken), /DOCUMENT_EVIDENCE_INVALID/);
});
test('anchors include actual source lines and fingerprints change with bytes', () => {
  const source = { id: 'example', path: 'packages/contracts/src/example.ts', anchors: ['marker'] };
  const first = inspectSource(source, Buffer.from('first\nmarker\n'));
  assert.equal(first.anchors[0].line, 2); assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.sha256, inspectSource(source, Buffer.from('other\nmarker\n')).sha256);
  assert.throws(() => inspectSource(source, Buffer.from('missing')), /SOURCE_ANCHOR_MISSING/);
});
test('oversized source is refused', () => {
  assert.throws(() => inspectSource({ id: 'large', anchors: ['a'] }, Buffer.alloc(1024 * 1024 + 1)), /SOURCE_SIZE_LIMIT/);
});
test('checked-in sources match the inventory; no runtime availability is inferred', async () => {
  const report = await auditInventory();
  assert.equal(report.status, 'SOURCE_EVIDENCE_VERIFIED');
  assert.equal(report.runtimeAvailability, 'NOT_INSPECTED');
  assert.equal(report.fiscalAcceptance, 'NOT_VERIFIED');
  assert.equal(report.remoteApi, 'NOT_IMPLEMENTED');
  assert.equal(report.sourceCount, inventory.sources.length);
  assert.equal(report.documentTypes.length, 6);
});
