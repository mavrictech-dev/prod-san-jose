import { parentPort, workerData } from 'node:worker_threads';
import { prepareNotesQaXml } from './notes-qa-pipeline';

const bytes = Buffer.from(workerData.bytes);
try {
  parentPort?.postMessage({ ok: true, result: prepareNotesQaXml(workerData.note, workerData.original, bytes, workerData.password, workerData.summaryIdentifier) });
} catch {
  parentPort?.postMessage({ ok: false }); // No propagar errores, certificados ni contraseñas.
} finally { bytes.fill(0); workerData.password = undefined; workerData.bytes = undefined; }
