import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request} from 'node:https';
import type {CallbackTransport} from './model';
export interface ApprovedDestination {id:string;url:string;addresses:readonly string[]}
const normalized=(ip:string)=>isIP(ip)===6?new URL('http://['+ip+']/').hostname.slice(1,-1):ip;
export function forbiddenAddress(ip:string){
  const family=isIP(ip);if(!family)return true;
  if(family===4){const b=ip.split('.').map(Number);return b[0]===0||b[0]===127||b[0]>=224||b[0]===169&&b[1]===254||['100.100.100.200','168.63.129.16'].includes(ip);}
  const n=normalized(ip);return ['fd00:ec2::254','fd20:ce::254'].includes(n)||!/^(?:[23][0-9a-f]{3}:|f[cd][0-9a-f]{2}:)/i.test(n)||/^2002:|^2001:(?:0:|:)/i.test(n);
}
export class HttpsCallbacks implements CallbackTransport {
  private readonly destinations=new Map<string,{url:URL;ips:Set<string>}>();
  constructor(approvals:readonly ApprovedDestination[],private readonly ca?:Buffer,
    private readonly resolve:typeof lookup=lookup){
    if(!approvals.length||approvals.length>100)throw new Error('Explicit approved callback destinations required');
    for(const d of approvals){const u=new URL(d.url);if(!/^[a-z][a-z0-9_-]{0,39}$/.test(d.id)||this.destinations.has(d.id)||u.protocol!=='https:'||u.username||u.password||u.search||u.hash||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(u.hostname)||isIP(u.hostname)||!d.addresses.length||d.addresses.some(forbiddenAddress))throw new Error('Unsafe callback approval');
      this.destinations.set(d.id,{url:u,ips:new Set(d.addresses.map(normalized))});}
  }
  ids(){return [...this.destinations.keys()];}
  async address(id:string){
    const d=this.destinations.get(id);if(!d)throw new Error('DESTINATION_NOT_APPROVED');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{const rows=await Promise.race([this.resolve(d.url.hostname,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS_TIMEOUT')),2000);})]);
      if(!rows.length||rows.length>32||rows.some(r=>forbiddenAddress(r.address)||!d.ips.has(normalized(r.address))))throw new Error('DNS_NOT_APPROVED');
      return {url:d.url,address:rows[0].address,family:rows[0].family};
    }finally{clearTimeout(timer);}
  }
  private async exchange(id:string,body:Buffer,headers:Record<string,string>){
    const target=await this.address(id);if(body.length>16384)throw new Error('BODY_LIMIT');
    return new Promise<{status:number;retryAfterSeconds?:number;body:Buffer}>((resolve,reject)=>{
      const req=request(target.url,{method:'POST',agent:false,ca:this.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',servername:target.url.hostname,
        // Resolve once, validate ALL answers, and pin this TCP connection. No second DNS lookup.
        lookup:((_host:any,options:any,cb:any)=>options.all?cb(null,[{address:target.address,family:target.family}]):cb(null,target.address,target.family)) as any,
        headers:{'Content-Type':'application/json','Content-Length':body.length,...headers},maxHeaderSize:8192},res=>{
        const chunks:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>4096)req.destroy(new Error('RESPONSE_LIMIT'));else chunks.push(b);});res.on('error',reject);res.on('aborted',()=>reject(new Error('INCOMPLETE_RESPONSE')));
        res.on('end',()=>{const raw=res.headers['retry-after'],n=typeof raw==='string'&&/^\d{1,5}$/.test(raw)?Math.min(Number(raw),3600):undefined;resolve({status:res.statusCode??0,retryAfterSeconds:n,body:Buffer.concat(chunks)});});
      });const timer=setTimeout(()=>req.destroy(new Error('CALLBACK_TIMEOUT')),10000);req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new Error('CALLBACK_UNAVAILABLE')));req.end(body);
    });
  }
  async send(id:string,body:Buffer,headers:Record<string,string>){const {status,retryAfterSeconds}=await this.exchange(id,body,headers);return {status,retryAfterSeconds};}
  async challenge(id:string,challenge:string){const r=await this.exchange(id,Buffer.from(JSON.stringify({type:'factuez.webhook.challenge.v1',challenge})),{'X-FactuEz-Verification':'challenge'});
    if(r.status!==200)return false;try{const v=JSON.parse(r.body.toString());return v&&Object.keys(v).join(',')==='challenge'&&v.challenge===challenge;}catch{return false;}}
}
