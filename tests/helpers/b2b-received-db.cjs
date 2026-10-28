'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const {withCorrectionDatabase}=require('./correction-reservation-db.cjs');

/** Reuses the owned, labelled, network-none/no-ports/tmpfs transport. The SQL
 * below is installed only in that helper's NEW database, never from an env URL.
 * The inherited Billing schema is a sentinel: tests assert no writes to it. */
async function withReceivedDatabase(work){
  assert.equal(process.env.FACTUEZ_B2B_RECEIVED_OWNED_DB,'NEW_NETWORK_NONE_TMPFS_ONLY','EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');
  return withCorrectionDatabase(async({pool})=>{
    const root=resolve(__dirname,'../..'),service=resolve(root,'services/received-documents-service');
    const local=createRequire(resolve(service,'package.json'));
    const ddl=spawnSync(process.execPath,[resolve(service,'node_modules/prisma/build/index.js'),'migrate','diff',
      '--from-empty','--to-schema','prisma/schema.prisma','--script'],{
      cwd:service,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,
      env:{...process.env,NODE_PATH:resolve(service,'node_modules'),DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected',PRISMA_HIDE_UPDATE_MESSAGE:'true'},
    });
    assert.equal(ddl.status,0,'RECEIVED_EMPTY_SCHEMA_GENERATION_FAILED');
    await pool.query(ddl.stdout);
    await pool.query(readFileSync(resolve(service,'b2b-received-read-schema.candidate.sql'),'utf8'));
    const {PrismaPg}=local('@prisma/adapter-pg');
    const {PrismaClient}=local('./dist/generated/prisma/client');
    const client=new PrismaClient({adapter:new PrismaPg(pool)});
    try{return await work({client,pool});}finally{await client.$disconnect();}
  });
}
module.exports={withReceivedDatabase};
