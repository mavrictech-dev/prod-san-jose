import { parentPort, workerData } from 'node:worker_threads';
import { XmlSignerService } from '../infrastructure/crypto/xml-signer.service';
const bytes = Buffer.from(workerData.bytes);
try { parentPort!.postMessage({ ok: true, result: new XmlSignerService().sign(workerData.xml, bytes, workerData.password, 'DespatchAdvice' as Parameters<XmlSignerService['sign']>[3]) }); }
catch { parentPort!.postMessage({ ok: false }); }
finally { bytes.fill(0); workerData.bytes.fill(0); workerData.password = ''; }
