import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSyntheticBundle, restoreSyntheticFiles} from '../infra/b2b/deployment-backup/synthetic-local-bundle.mjs';

const make = () => createSyntheticBundle(Buffer.from('synthetic opaque bytes'), [{name:'sample.xml', bytes:Buffer.from('<synthetic/>')}, {name:'empty.txt', bytes:Buffer.alloc(0)}]);
test('restaura archivos sintéticos en un directorio nuevo sin tocar el respaldo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factuez-local-test-'));
  try {
    const bundle = make(), first = await restoreSyntheticFiles(bundle, root), second = await restoreSyntheticFiles(bundle, root);
    assert.notEqual(first.directory, second.directory);
    assert.equal(first.postgresRestored, false);
    assert.equal((await readFile(path.join(first.directory, 'archive.dump'))).toString(), 'synthetic opaque bytes');
    assert.equal((await readFile(path.join(first.directory, 'sample.xml'))).toString(), '<synthetic/>');
    assert.deepEqual((await readdir(first.directory)).sort(), ['archive.dump','empty.txt','sample.xml']);
  } finally { await rm(root, {recursive:true, force:true}); }
});
test('rechaza alteraciones y rutas inseguras antes de crear un destino', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factuez-local-test-'));
  try {
    for (const change of [b => b.archive.data = 'eA==', b => b.files[0].name = '../x.xml', b => b.files.push({...b.files[0]}), b => b.files[0].data = '%%%%', b => b.format = 'PRODUCTION']) {
      const b = make(); change(b); await assert.rejects(restoreSyntheticFiles(b, root));
      assert.deepEqual(await readdir(root), []);
    }
    assert.throws(() => createSyntheticBundle(Buffer.alloc(4*1024*1024+1), []));
    assert.throws(() => createSyntheticBundle(Buffer.alloc(0), [{name:'x.txt', bytes:Buffer.alloc(0)}, {name:'x.txt', bytes:Buffer.alloc(0)}]));
  } finally { await rm(root, {recursive:true, force:true}); }
});