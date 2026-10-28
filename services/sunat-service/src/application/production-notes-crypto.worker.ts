import { parentPort, workerData } from 'node:worker_threads';
import { prepareProductionNotesXml } from './production-notes-crypto';
const bytes = Buffer.from(workerData.bytes);
try {
    parentPort!.postMessage({ ok: true, value: prepareProductionNotesXml(workerData.snapshot, bytes, workerData.password, workerData.context) });
}
catch {
    parentPort!.postMessage({ ok: false });
}
finally {
    bytes.fill(0);
}
