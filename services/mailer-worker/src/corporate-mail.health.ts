import { Injectable } from '@nestjs/common';
@Injectable()
export class CorporateMailHealth {
  queueReady = false;
  workerReady = false;
  get ready() { return this.queueReady && this.workerReady; }
}
