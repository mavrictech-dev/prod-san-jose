import {Queue,Worker,type ConnectionOptions} from 'bullmq';
import type {Webhooks} from './core';
/** Redis is a wake-up accelerator; the owner DB remains the durable queue. */
export class WebhookWorker {
  private ticking?:Promise<void>;private timer?:ReturnType<typeof setInterval>;private worker?:Worker;private queue?:Queue;
  private stopped=false;private closing?:Promise<void>;private deliveries=new Set<Promise<unknown>>();private wakes=new Set<Promise<void>>();
  constructor(private readonly core:Webhooks){}
  tick():Promise<void>{
    if(this.stopped)return Promise.resolve();if(this.ticking)return this.ticking;
    this.ticking=Promise.resolve().then(async()=>{for(let i=0;i<25&&!this.stopped;i++){if(!await this.core.dispatch())break;}}).finally(()=>{this.ticking=undefined;});return this.ticking;
  }
  start(connection?:ConnectionOptions){if(this.stopped||this.timer||this.worker||this.queue)throw new Error('WEBHOOK_WORKER_NOT_STARTABLE');
    if(connection){this.queue=new Queue('factuez-b2b-webhooks-v1',{connection});this.queue.on('error',()=>{});
      this.worker=new Worker('factuez-b2b-webhooks-v1',async job=>{if(this.stopped)throw new Error('WEBHOOK_WORKER_STOPPED');if(!job.data||Object.keys(job.data).join(',')!=='deliveryId'||!/^[a-f0-9-]{36}$/.test(job.data.deliveryId))throw new Error('Invalid wakeup');
        const work=Promise.resolve().then(()=>this.core.dispatch(job.data.deliveryId));this.deliveries.add(work);try{await work;}finally{this.deliveries.delete(work);}
      },{connection,concurrency:2});this.worker.on('error',()=>{});}
    this.timer=setInterval(()=>{void this.tick().catch(()=>{});},2000);this.timer.unref();
  }
  wake(deliveryId:string):Promise<void>{
    if(!/^[a-f0-9-]{36}$/.test(deliveryId))return Promise.reject(new Error('Invalid wakeup'));if(this.stopped)return Promise.resolve();
    const work=(async()=>{try{await this.queue?.add('delivery',{deliveryId},{jobId:deliveryId,removeOnComplete:100,removeOnFail:100});}catch{/* DB polling recovers; never discard a durable row. */}})();
    this.wakes.add(work);void work.then(()=>this.wakes.delete(work),()=>this.wakes.delete(work));return work;
  }
  close():Promise<void>{
    if(this.closing)return this.closing;this.stopped=true;clearInterval(this.timer);this.timer=undefined;
    this.closing=(async()=>{
      const results=await Promise.allSettled([Promise.resolve().then(()=>this.worker?.close()),this.ticking,...this.deliveries,...this.wakes]);
      let failed=results.some(r=>r.status==='rejected');try{await this.queue?.close();}catch{failed=true;}
      if(failed)throw new Error('WEBHOOK_WORKER_CLOSE_FAILED');
    })();return this.closing;
  }
}
