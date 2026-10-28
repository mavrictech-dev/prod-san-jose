import { parentPort, workerData } from "node:worker_threads";
import { inspectCertificate } from "./certificate-inspector";

const bytes = Buffer.from(workerData.bytes);
try {
  const metadata = inspectCertificate(bytes, workerData.password);
  parentPort!.postMessage({ ok: true, metadata });
} catch {
  // No enviamos contenido, contraseña ni excepciones de librerías al padre/logs.
  parentPort!.postMessage({ ok: false });
} finally {
  bytes.fill(0); workerData.bytes.fill(0); workerData.password = "";
}
