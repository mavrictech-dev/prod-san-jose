import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { SignedXmlResult } from '../infrastructure/crypto/xml-signer.service';
@Injectable()
export class GreQaSigningService {
  private active = 0;
  async sign(xml: string, bytes: Buffer, password: string): Promise<SignedXmlResult> {
    if (this.active >= 2) throw new ServiceUnavailableException('Hay firmas GRE en curso; reintente');
    if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || bytes.length > 512 * 1024) throw new BadRequestException('Firma GRE fuera de límites');
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        let worker: Worker;
        try { worker = new Worker(join(__dirname,'gre-qa-sign.worker.js'), { workerData: { xml, bytes, password }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } }); }
        catch { reject(new ServiceUnavailableException('Worker GRE no disponible')); return; }
        let settled = false;
        const timer = setTimeout(() => finish(),10000);
        function finish(result?: SignedXmlResult) {
          if (settled) return; settled = true; clearTimeout(timer);
          void worker.terminate().catch(() => undefined).then(() => result ? resolve(result) : reject(new BadRequestException('No se pudo firmar y verificar GRE dentro del límite seguro')));
        }
        worker.once('message', msg => finish(msg.ok ? msg.result : undefined)); worker.once('error', () => finish()); worker.once('exit', () => finish());
      });
    } finally { this.active--; }
  }
}
