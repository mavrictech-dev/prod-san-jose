import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { deny } from './b2b-production-contract';
export interface ProductionDestination {id:string;url:string;addresses:readonly string[]}
export interface ProductionCallbackTransport { ids():string[];send(id:string,body:Buffer,headers:Record<string,string>):Promise<{status:number;body:Buffer;retryAfterSeconds?:number}> }
export function productionPublicAddress(ip:string){const f=isIP(ip);if(f===4){const [a,b]=ip.split('.').map(Number);return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===2))&&!(a===198&&(b===18||b===19||b===51))&&!(a===203&&b===0)&&ip!=='168.63.129.16';}if(f===6){const n=new URL('http://['+ip+']/').hostname.slice(1,-1);return /^[23][0-9a-f]{3}:/i.test(n)&&!/^2001:(?:db8|0|2|10|20):|^2002:/i.test(n);}return false;}
const normalize=(ip:string)=>isIP(ip)===6?new URL('http://['+ip+']/').hostname.slice(1,-1):ip;
/** Allowlist supplied by installer. No caller-supplied URLs, redirects, proxy or TLS bypass. */
export class ProductionHttpsCallbacks implements ProductionCallbackTransport {
 private readonly targets=new Map<string,{url:URL;ips:Set<string>}>();
 constructor(destinations:readonly ProductionDestination[],private readonly ca?:Buffer,private readonly resolve:typeof lookup=lookup){for(const d of destinations){const u=new URL(d.url);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(d.id)||this.targets.has(d.id)||u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password||u.search||u.hash||isIP(u.hostname)||!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(u.hostname)||!d.addresses.length||d.addresses.some(ip=>!productionPublicAddress(ip)))throw Error('UNSAFE_PRODUCTION_DESTINATION');this.targets.set(d.id,{url:u,ips:new Set(d.addresses.map(normalize))});}}
 ids(){return [...this.targets.keys()];}
 async send(id:string,body:Buffer,headers:Record<string,string>){const d=this.targets.get(id);if(!d)deny(400,'DESTINATION_NOT_APPROVED');if(body.length>65536)deny(400,'EVENT_TOO_LARGE');let dnsTimer:ReturnType<typeof setTimeout>|undefined;
 const rows=await Promise.race([this.resolve(d.url.hostname,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('DNS_TIMEOUT')),2000);})]).finally(()=>clearTimeout(dnsTimer));if(!rows.length||rows.length>32||rows.some(r=>!productionPublicAddress(r.address)||!d.ips.has(normalize(r.address))))deny(503,'DNS_NOT_APPROVED');const pin=rows[0];
 return new Promise<{status:number;body:Buffer;retryAfterSeconds?:number}>((resolve,reject)=>{const req=request(d.url,{method:'POST',agent:false,ca:this.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',servername:d.url.hostname,maxHeaderSize:8192,
 lookup:((_h:any,o:any,cb:any)=>o.all?cb(null,[pin]):cb(null,pin.address,pin.family)) as any,headers:{...headers,'Content-Type':'application/json','Content-Length':body.length}},res=>{const chunks:Buffer[]=[];let length=0;res.on('data',(v:Buffer)=>{length+=v.length;if(length>4096)req.destroy(Error('ACK_TOO_LARGE'));else chunks.push(v);});res.on('aborted',()=>reject(Error('ACK_ABORTED')));res.on('error',reject);res.on('end',()=>{const retry=res.headers['retry-after'];resolve({status:res.statusCode??0,body:Buffer.concat(chunks),retryAfterSeconds:typeof retry==='string'&&/^\d{1,5}$/.test(retry)?Math.min(3600,Number(retry)):undefined});});});const timer=setTimeout(()=>req.destroy(Error('CALLBACK_TIMEOUT')),10000);req.once('close',()=>clearTimeout(timer));req.once('error',()=>reject(Error('CALLBACK_UNAVAILABLE')));req.end(body);});
 }
}
