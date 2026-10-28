import { parentPort, workerData } from 'node:worker_threads';
import { prepareProductionBatchesXml } from './production-batches-crypto';
const bytes=Buffer.from(workerData.bytes);
try{parentPort!.postMessage({ok:true,value:prepareProductionBatchesXml(workerData.snapshot,bytes,workerData.password)});}
catch{parentPort!.postMessage({ok:false});}
finally{bytes.fill(0);}
