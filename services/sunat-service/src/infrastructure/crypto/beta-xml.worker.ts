import { parentPort, workerData } from 'node:worker_threads';
import { prepareBetaXml } from './beta-xml-pipeline';
const bytes = Buffer.from(workerData.bytes);
try { parentPort!.postMessage({ ok: true, result: prepareBetaXml(workerData.snapshot, bytes, workerData.password, workerData.identifier) }); }
catch { parentPort!.postMessage({ ok: false }); }
finally { bytes.fill(0); workerData.bytes.fill(0); workerData.password = ''; }
