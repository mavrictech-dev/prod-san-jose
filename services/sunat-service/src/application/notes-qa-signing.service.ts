import { Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { NoteQaSnapshot } from '@factuez/sunat-core/dist/notes-qa';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { prepareNotesQaXml } from './notes-qa-pipeline';

@Injectable()
export class NotesQaSigningService {
  private active = 0;
  async prepare(note: NoteQaSnapshot, original: FiscalDocumentSnapshot, bytes: Buffer, password: string, summaryIdentifier?: string): Promise<ReturnType<typeof prepareNotesQaXml>> {
    if (this.active >= 1) throw new ServiceUnavailableException('Firma de notas ocupada');
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        let worker: Worker;
        try { worker = new Worker(join(__dirname, 'notes-qa-crypto.worker.js'), {
          workerData: { note, original, bytes, password, summaryIdentifier }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
        }); } catch { reject(new ServiceUnavailableException('Worker de notas no disponible')); return; }
        let settled = false;
        const finish = (result?: ReturnType<typeof prepareNotesQaXml>) => {
          if (settled) return; settled = true; clearTimeout(timer);
          void worker.terminate().catch(() => undefined).then(() => result
            ? resolve({ ...result, zip: Buffer.from(result.zip) })
            : reject(new BadRequestException('No se pudo firmar la nota dentro del límite seguro')));
        };
        const timer = setTimeout(() => finish(), 10000);
        worker.once('message', message => finish(message?.ok ? message.result : undefined));
        worker.once('error', () => finish()); worker.once('exit', () => finish());
      });
    } finally { this.active--; }
  }
}
