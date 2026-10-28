import {describe,it,expect} from 'vitest';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {HookVault,newSigningSecret,signWebhook,verifyWebhook} from '../services/webhook-service/src/crypto';
import {HttpsCallbacks,forbiddenAddress} from '../services/webhook-service/src/destination';
const sdk=createRequire(new URL('../services/webhook-service/package.json',import.meta.url))('standardwebhooks');
describe('B2B-05 signing/SSRF boundary',()=>{
  it('interoperates with the maintained SDK and independent HMAC calculation on exact UTF-8 bytes',()=>{
    const secret=newSigningSecret(),id=randomUUID(),now=Date.now(),ts=Math.floor(now/1000),bytes=Buffer.from('{"mensaje":"Piura · Perú"}');
    const signature=signWebhook(secret,id,ts,bytes),expected='v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(id+'.'+ts+'.').update(bytes).digest('base64');expect(signature).toBe(expected);
    const headers={'webhook-id':id,'webhook-timestamp':String(ts),'webhook-signature':signature};expect(new sdk.Webhook(secret).verify(bytes,headers)).toEqual(JSON.parse(bytes.toString()));expect(verifyWebhook([secret],bytes,headers,now)).toBe(id);
    for(const changed of [Buffer.from('{}'),Buffer.concat([bytes,Buffer.from(' ')])])expect(()=>verifyWebhook([secret],changed,headers,now)).toThrow();
    expect(()=>verifyWebhook([secret],bytes,headers,now+301000)).toThrow();expect(()=>verifyWebhook([secret],bytes,{...headers,'webhook-timestamp':String(ts+301)},now)).toThrow();
  });
  it('vault authenticates ciphertext and subscription-specific AAD',()=>{const v=new HookVault(randomBytes(32)),secret=newSigningSecret(),id=randomUUID(),sealed=v.seal(secret,id);expect(v.open(sealed,id)).toBe(secret);expect(()=>v.open(sealed,randomUUID())).toThrow();const b=Buffer.from(sealed,'base64');b[30]^=1;expect(()=>v.open(b.toString('base64'),id)).toThrow();});
  it.each(['127.0.0.1','127.1.2.3','0.0.0.0','169.254.169.254','100.100.100.200','168.63.129.16','224.0.0.1','::','::1','::ffff:127.0.0.1','::7f00:1','64:ff9b::7f00:1','2002:7f00:1::','fe80::1','ff02::1','fd00:ec2::254','fd20:ce::254','not-ip'])('always blocks metadata/loopback/link-local %s',ip=>expect(forbiddenAddress(ip)).toBe(true));
  it.each(['http://erp.test/callback','https://user:pass@erp.test/a','https://erp.test/a?token=x','https://erp.test/#x','https://127.0.0.1/a'])('rejects unsafe approved URLs %s',url=>expect(()=>new HttpsCallbacks([{id:'erp',url,addresses:['10.10.10.10']}])).toThrow());
  it('permits only specifically approved VPN addresses, rejects mixed and rebound DNS answers',async()=>{
    let answers=[{address:'10.10.10.10',family:4}];const transport=new HttpsCallbacks([{id:'erp',url:'https://erp.test/callback',addresses:['10.10.10.10','2001:db8::1']}],undefined,(async()=>answers) as any);
    expect((await transport.address('erp')).address).toBe('10.10.10.10');answers=[{address:'10.10.10.11',family:4}];await expect(transport.address('erp')).rejects.toThrow('DNS_NOT_APPROVED');answers=[{address:'10.10.10.10',family:4},{address:'169.254.169.254',family:4}];await expect(transport.address('erp')).rejects.toThrow();answers=[{address:'2001:db8::1',family:6}];expect((await transport.address('erp')).family).toBe(6);
  });
});
