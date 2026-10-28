import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { inspectCertificate } from "./certificate-inspector";

/** La carga de un PFX ajeno nunca bloquea el event loop de facturación. */
@Injectable()
export class CertificateInspectionService {
  private active = 0;
  async inspect(bytes: Buffer, password: string): Promise<ReturnType<typeof inspectCertificate>> {
    if (this.active >= 2) throw new ServiceUnavailableException("Hay validaciones de certificado en curso. Reintente");
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        let worker: Worker;
        try {
          worker = new Worker(join(__dirname, "certificate-inspector.worker.js"), {
            workerData: { bytes, password },
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
          });
        } catch { reject(new ServiceUnavailableException("Validador de certificados no disponible")); return; }
        let settled = false;
        const finish = (value?: ReturnType<typeof inspectCertificate>) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          void worker.terminate().catch(() => undefined).then(() => {
            if (value) resolve(value);
            else reject(new BadRequestException("No se pudo validar el PKCS#12 dentro del límite seguro"));
          });
        };
        const timer = setTimeout(() => finish(), 5000);
        worker.once("message", result => finish(result.ok ? result.metadata : undefined));
        worker.once("error", () => finish());
        worker.once("exit", () => finish());
      });
    } finally { this.active--; }
  }
}
