import type {B2bExtraction} from './core';
/** One owned task includes expiration, packaging and its durable completion.
 * A timeout or HTTP disconnect must not release its database underneath it. */
export class B2bExtractionWorker {
 #active?:Promise<void>;#closing?:Promise<void>;#timer?:ReturnType<typeof setInterval>;#stopped=false;
 constructor(private readonly core:Pick<B2bExtraction,'sweep'|'runOne'>){}
 tick():Promise<void>{
  if(this.#stopped)return Promise.resolve();
  return this.#active??=Promise.resolve().then(async()=>{await this.core.sweep();if(!this.#stopped)await this.core.runOne();}).finally(()=>{this.#active=undefined;});
 }
 start(){if(this.#stopped||this.#timer)throw Error('EXPORT_WORKER_NOT_STARTABLE');this.#timer=setInterval(()=>{void this.tick().catch(()=>{});},1000);this.#timer.unref();}
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#stopped=true;clearInterval(this.#timer);this.#timer=undefined;
  return this.#closing=Promise.resolve().then(()=>this.#active).then(()=>{},()=>{throw Error('EXPORT_WORKER_CLOSE_FAILED');});
 }
}
