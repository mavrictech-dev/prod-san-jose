import { Injectable, BadRequestException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { prepareBetaXml } from './beta-xml-pipeline';
import { LocalPreparationUnavailableError } from '../../application/local-preparation-policy';
@Injectable()
export class BetaXmlWorkerService {
  private active = 0;
  async prepare(snapshot: FiscalDocumentSnapshot, bytes: Buffer, password: string, identifier?: string): Promise<ReturnType<typeof prepareBetaXml>> {
    if (this.active >= 2) throw new LocalPreparationUnavailableError('Worker criptográfico ocupado');
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        let worker: Worker;
        try { worker = new Worker(join(__dirname, 'beta-xml.worker.js'), { workerData: { snapshot, bytes, password, identifier },
          resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } }); }
        catch { reject(new LocalPreparationUnavailableError('Worker criptográfico no disponible')); return; }
        let settled = false;
        const finish = (result?: ReturnType<typeof prepareBetaXml>, temporary = false) => {
          if (settled) return; settled = true; clearTimeout(timer);
          void worker.terminate().catch(() => undefined).then(() => result ? resolve({ ...result, zip: Buffer.from(result.zip), individualZip: result.individualZip ? Buffer.from(result.individualZip) : undefined }) :
            reject(temporary ? new LocalPreparationUnavailableError('Worker criptográfico interrumpido') : new BadRequestException('Firma/contexto Beta inválido')));
        };
        const timer = setTimeout(() => finish(undefined, true), 10000);
        worker.once('message', message => finish(message.ok ? message.result : undefined));
        worker.once('error', () => finish(undefined, true)); worker.once('exit', () => finish(undefined, true));
      });
    } finally { this.active--; }
  }
}
