import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { prepareLocalXml } from './local-xml-pipeline';

@Injectable()
export class LocalXmlWorkerService {
  private active = 0;
  async prepare(snapshot: FiscalDocumentSnapshot, bytes: Buffer, password: string, summaryIdentifier?: string): Promise<ReturnType<typeof prepareLocalXml>> {
    if (this.active >= 2) throw new ServiceUnavailableException('Hay pruebas criptográficas en curso. Reintente');
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        let worker: Worker;
        try { worker = new Worker(join(__dirname, 'local-xml.worker.js'), { workerData: { snapshot, bytes, password, summaryIdentifier }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } }); }
        catch { reject(new ServiceUnavailableException('Worker de firma no disponible')); return; }
        let settled = false;
        const finish = (result?: ReturnType<typeof prepareLocalXml>) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          void worker.terminate().catch(() => undefined).then(() => result ? resolve({ ...result, zip: Buffer.from(result.zip) }) : reject(new BadRequestException('No se pudo validar y firmar el XML dentro del límite seguro')));
        };
        const timer = setTimeout(() => finish(), 10000);
        worker.once('message', message => finish(message.ok ? message.result : undefined));
        worker.once('error', () => finish()); worker.once('exit', () => finish());
      });
    } finally { this.active--; }
  }
}
