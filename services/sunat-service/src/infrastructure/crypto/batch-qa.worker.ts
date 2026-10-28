import { parentPort, workerData } from 'node:worker_threads';
import { prepareBatchQa } from './local-batch';
const bytes = Buffer.from(workerData.bytes);
try { parentPort!.postMessage({ ok: true, result: prepareBatchQa(workerData.input, workerData.identifier, bytes, workerData.password) }); }
catch { parentPort!.postMessage({ ok: false }); }
finally { bytes.fill(0); workerData.bytes.fill(0); workerData.password = ''; }
