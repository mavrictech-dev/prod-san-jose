import { parentPort, workerData } from 'node:worker_threads';
import { prepareLocalXml } from './local-xml-pipeline';
import { prepareLocalSummary } from './local-summary';
const bytes = Buffer.from(workerData.bytes);
try { parentPort!.postMessage({ ok: true, result: workerData.summaryIdentifier ? prepareLocalSummary(workerData.snapshot, bytes, workerData.password, workerData.summaryIdentifier) : prepareLocalXml(workerData.snapshot, bytes, workerData.password) }); }
catch { parentPort!.postMessage({ ok: false }); }
finally { bytes.fill(0); workerData.bytes.fill(0); workerData.password = ''; }
