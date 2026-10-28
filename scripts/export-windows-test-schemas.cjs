'use strict';
// Fresh test databases only. Original exporter retains owner/empty-target guards.
const {spawnSync}=require('node:child_process');const {readFileSync,writeFileSync,chmodSync}=require('node:fs');const {join}=require('node:path');const {createHash}=require('node:crypto');
const target=process.argv[2];if(process.argv.length!==3)throw Error('NEW_TARGET_REQUIRED');
const result=spawnSync(process.execPath,[join(__dirname,'export-production-schemas.cjs'),target],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);
const extra={
 'billing-service':['production-batches-schema.sql','production-guides.sql'],
 'sunat-service':['production-notes-rc-schema.sql','production-batches-schema.sql','production-guides.sql']
};
const manifestPath=join(target,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath));
for(const e of manifest.files){
 const additions=(extra[e.service]??[]).map(name=>{let s=readFileSync(join(__dirname,'..','services',e.service,'prisma',name),'utf8');const start=s.indexOf('BEGIN;'),end=s.lastIndexOf('COMMIT;');return start>=0&&end>start?s.slice(start+6,end):s;}).join('\n');
 const file=join(target,e.name);let sql=readFileSync(file,'utf8');const end=sql.lastIndexOf('COMMIT;');if(end<0)throw Error('TRANSACTION_REQUIRED');sql=sql.slice(0,end)+'\n'+additions+'\nCOMMIT;\n';writeFileSync(file,sql);e.bytes=Buffer.byteLength(sql);e.sha256=createHash('sha256').update(sql).digest('hex');
}
manifest.scope='NEW_EMPTY_WINDOWS_TEST_DATABASES_ONLY';writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');// SQL contains schema only, not secrets. PostgreSQL uid must read the mounted public baseline.
chmodSync(target,0o755);for(const e of manifest.files)chmodSync(join(target,e.name),0o644);chmodSync(manifestPath,0o644);console.log('WINDOWS_TEST_SCHEMAS_READY');
