import {describe,it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>[] as any[]);
vi.mock('node:https',async()=>{
  const {EventEmitter}=await import('node:events');
  return {request:(url:any,options:any,callback:any)=>{calls.push({url,options});const req:any=new EventEmitter();req.destroy=(e:Error)=>{req.emit('error',e);req.emit('close');};req.end=()=>queueMicrotask(()=>{const res:any=new EventEmitter();res.statusCode=302;res.headers={location:'http://169.254.169.254/latest/meta-data/'};callback(res);res.emit('data',Buffer.from('{}'));res.emit('end');req.emit('close');});return req;}};
});
import {HttpsCallbacks} from '../services/webhook-service/src/destination';
describe('B2B-05 pinned HTTPS options and redirect refusal',()=>{
  it('pins the approved address while preserving hostname/SNI/TLS and never follows a redirect',async()=>{
    calls.length=0;let answer='10.20.30.40';const resolver=vi.fn(async()=>[{address:answer,family:4}]);
    const http=new HttpsCallbacks([{id:'erp',url:'https://erp.test:8443/callback',addresses:['10.20.30.40']}],Buffer.from('synthetic-ca'),resolver as any);
    expect((await http.send('erp',Buffer.from('{}'),{})).status).toBe(302);expect(calls).toHaveLength(1);const {url,options}=calls[0];expect(url.hostname).toBe('erp.test');expect(url.port).toBe('8443');expect(options).toMatchObject({rejectUnauthorized:true,agent:false,minVersion:'TLSv1.2',servername:'erp.test'});
    answer='169.254.169.254';let actual:any;options.lookup('erp.test',{all:true},(_e:any,value:any)=>{actual=value;});expect(actual).toEqual([{address:'10.20.30.40',family:4}]);expect(resolver).toHaveBeenCalledTimes(1);
    await expect(http.send('erp',Buffer.from('{}'),{})).rejects.toThrow('DNS_NOT_APPROVED');expect(calls).toHaveLength(1);
  });
});
