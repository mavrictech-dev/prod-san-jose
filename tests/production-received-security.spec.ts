import {afterEach,describe,it,expect,vi} from 'vitest';
const dns=vi.hoisted(()=>({lookup:vi.fn()}));
vi.mock('node:dns',()=>({lookup:dns.lookup}));
import {publicAddress,publicLookup,receptionHttpsFetch} from '../services/received-documents-service/src/automation/network';
import {automationCompany,hasActivation} from '../services/received-documents-service/src/automation/authorization';
import {NativeReceptionScheduler} from '../services/received-documents-service/src/automation/scheduler';
import {defaultReceptionSettings} from '../services/received-documents-service/src/automation/policy';
import {ReceptionProductionWorkflow} from '../services/received-documents-service/src/automation/readiness';
import {ReceptionVault} from '../services/received-documents-service/src/automation/vault';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('production reception network and durable authorization',()=>{
  it.each(['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','192.0.2.1','198.18.0.1','203.0.113.1','192.88.99.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2001:20::1','2002:808:808::','3fff::1'])('rejects non-public destination %s',address=>expect(publicAddress(address)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','2001:4860:4860::8888','2606:4700:4700::1111'])('admits public destination %s',address=>expect(publicAddress(address)).toBe(true));
  it('rejects mixed public/private DNS and never chooses the public subset',async()=>{
    dns.lookup.mockImplementation((_host:unknown,_options:unknown,cb:Function)=>cb(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
    const error=await new Promise(resolve=>publicLookup('imap.synthetic.example.com',{},e=>resolve(e)));
    expect(error).toBeInstanceOf(Error);
  });
  it('revalidates DNS for every connection and supports Node all-address lookup',async()=>{
    dns.lookup.mockImplementationOnce((_h:unknown,_o:unknown,cb:Function)=>cb(null,[{address:'8.8.8.8',family:4}])).mockImplementationOnce((_h:unknown,_o:unknown,cb:Function)=>cb(null,[{address:'10.0.0.1',family:4}]));
    const first=await new Promise(resolve=>publicLookup('imap.synthetic.example.com',{all:true},(e,a)=>resolve({e,a})));
    expect(first).toEqual({e:null,a:[{address:'8.8.8.8',family:4}]});
    expect(await new Promise(resolve=>publicLookup('imap.synthetic.example.com',{},e=>resolve(e)))).toBeInstanceOf(Error);
  });
  it.each(['http://api-sire.sunat.gob.pe','https://evil.example.com','https://api-sire.sunat.gob.pe:8443','https://user:password@api-sire.sunat.gob.pe'])('rejects origin before opening any socket %s',async url=>{await expect(receptionHttpsFetch(url)).rejects.toThrow('RECEPTION_ORIGIN_REJECTED');});
  it('does not authorize enabled legacy rows without the RUC revision activation audit',async()=>{
    const db={receptionConnectionAudit:{findFirst:vi.fn(async()=>null)}} as any;
    expect(await hasActivation(db,{companyId:1,recipientRuc:'00000000101',revision:2,mode:'LIVE_READ_ONLY'} as any)).toBe(false);
    expect(db.receptionConnectionAudit.findFirst.mock.calls[0][0].where).toMatchObject({companyId:1,revision:2,action:'PRODUCTION_ACTIVATED',detail:{path:['recipientRuc'],equals:'00000000101'}});
  });
  it('paginates all enabled RUCs and recovers more than 100 durable runs',async()=>{
    vi.stubEnv('RECEIVED_LOCAL_FIXTURE_ENABLED','true');const settings=defaultReceptionSettings();settings.mode='LOCAL_FIXTURE';
    const configs=Array.from({length:205},(_,i)=>({companyId:i+1,recipientRuc:'00000000101',revision:1,settings}));
    const pending=Array.from({length:205},(_,i)=>({id:String(i+1).padStart(6,'0')}));
    const db={receptionConnection:{findMany:vi.fn(async(q:any)=>configs.filter(c=>c.companyId>(q.where.companyId?.gt??0)).slice(0,100))},receptionSyncRun:{findMany:vi.fn(async(q:any)=>pending.filter(r=>r.id>(q.where.id?.gt??'')).slice(0,100))}} as any;
    const enqueue=vi.fn(async()=>{}),scheduler=new NativeReceptionScheduler(db,enqueue);
    await scheduler.tick();expect(enqueue).toHaveBeenCalledTimes(205);expect(db.receptionConnection.findMany).toHaveBeenCalledTimes(3);expect(scheduler.lastTick).toBeGreaterThan(0);await scheduler.pause();
  });
  it('server readiness probes metadata with LIMIT 0 and never asks for customer data',async()=>{
    const query=vi.fn(async()=>[]);vi.spyOn(ReceptionVault.prototype,'seal').mockReturnValue('SYNTHETIC');vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED','false');
    const result=await new ReceptionProductionWorkflow({$queryRaw:query} as any).serverReadiness();expect(result).toMatchObject({ready:false,checks:{database:true,encryption:true,externalReadAllowed:false}});
    expect(query).toHaveBeenCalledTimes(11);for(const [strings]of query.mock.calls as any)expect(strings.join('')).toMatch(/LIMIT 0$/);
  });
});
