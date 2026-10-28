import { parentPort, workerData } from 'node:worker_threads';
import { prepareBetaFiscalPackage } from './beta-fiscal-package-pipeline';
const bytes = Buffer.from(workerData.bytes);
try { parentPort!.postMessage({ ok: true, result: prepareBetaFiscalPackage(workerData.envelope, bytes, workerData.password) }); }
catch { parentPort!.postMessage({ ok: false }); }
finally { bytes.fill(0); workerData.bytes.fill(0); workerData.password = ''; }
