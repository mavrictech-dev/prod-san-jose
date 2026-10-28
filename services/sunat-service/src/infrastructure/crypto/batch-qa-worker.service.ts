import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { BatchQaInput, prepareBatchQa } from './local-batch';
@Injectable()
export class BatchQaWorkerService {
  private active = 0;
  async prepare(input: BatchQaInput, identifier: string, bytes: Buffer, password: string): Promise<ReturnType<typeof prepareBatchQa>> {
    if (this.active >= 2) throw new ServiceUnavailableException('Firmador de lotes ocupado; reintente');
    this.active++;
    try { return await new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(join(__dirname,'batch-qa.worker.js'), { workerData: { input, identifier, bytes, password }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } }); }
      catch { reject(new ServiceUnavailableException('Firmador de lotes no disponible')); return; }
      let settled = false;
      const finish = (result?: ReturnType<typeof prepareBatchQa>) => {
        if (settled) return; settled = true; clearTimeout(timer);
        void worker.terminate().catch(() => undefined).then(() => result ? resolve({ ...result, zip: Buffer.from(result.zip) }) : reject(new BadRequestException('Lote no pudo firmarse dentro del límite seguro')));
      };
      const timer = setTimeout(() => finish(),10000);
      worker.once('message', message => finish(message.ok ? message.result : undefined)); worker.once('error', () => finish()); worker.once('exit', () => finish());
    }); } finally { this.active--; }
  }
}
