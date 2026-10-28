import { BadRequestException, Injectable } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { BetaFiscalEnvelope, prepareBetaFiscalPackage } from './beta-fiscal-package-pipeline';
import { LocalPreparationUnavailableError } from '../../application/local-preparation-policy';
@Injectable()
export class BetaFiscalPackageWorkerService {
  private active = 0;
  async prepare(envelope: BetaFiscalEnvelope, bytes: Buffer, password: string): Promise<ReturnType<typeof prepareBetaFiscalPackage>> {
    if (this.active >= 2) throw new LocalPreparationUnavailableError(); this.active++;
    try { return await new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(join(__dirname, 'beta-fiscal-package.worker.js'), { workerData: { envelope, bytes, password },
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } }); }
      catch { reject(new LocalPreparationUnavailableError()); return; }
      let settled = false;
      const finish = (result?: ReturnType<typeof prepareBetaFiscalPackage>, temporary = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        void worker.terminate().catch(() => undefined).then(() => result ? resolve({ ...result, zip: Buffer.from(result.zip) }) :
          reject(temporary ? new LocalPreparationUnavailableError() : new BadRequestException('Paquete fiscal Beta inválido')));
      };
      const timer = setTimeout(() => finish(undefined, true), 10000);
      worker.once('message', message => finish(message.ok ? message.result : undefined));
      worker.once('error', () => finish(undefined, true)); worker.once('exit', () => finish(undefined, true));
    }); } finally { this.active--; }
  }
}
