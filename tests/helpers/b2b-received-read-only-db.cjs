'use strict';
const {readFileSync}=require('node:fs');const {resolve}=require('node:path');
const assert=require('node:assert/strict');
const {withReceivedAutomationDatabase}=require('./b2b-received-automation-db.cjs');
exports.withReceivedReadOnlyDatabase=work=>withReceivedAutomationDatabase(async context=>{
 try{await context.pool.query(readFileSync(resolve(__dirname,'../../services/received-documents-service/b2b-received-read-only.candidate.sql'),'utf8'));}
 catch(e){throw new Error('READ_ONLY_DDL_FAILED '+JSON.stringify({code:e.code,position:e.position,internalPosition:e.internalPosition,where:e.where,message:e.message}));}
 await context.pool.query('CREATE DATABASE b2b_report_read_grants_synthetic');
 const reportsPool=new context.pool.constructor({...context.pool.options,database:'b2b_report_read_grants_synthetic',max:3});
 const idleErrors=[];
 reportsPool.on('error',error=>{
  // BusyBox nc may close its Docker-exec stream while pg flushes Terminate.
  // Only that expected, already-closing client error is teardown noise. Keep
  // every other idle error as an assertion failure rather than a swallowed
  // asynchronous exception or an apparently successful JSON test report.
  if(reportsPool.ending&&error.code==='ERR_STREAM_DESTROYED'&&error.client?._ending===true)return;
  idleErrors.push(error.code??'UNEXPECTED_ISOLATED_POOL_ERROR');
 });
 try{
  await reportsPool.query(readFileSync(resolve(__dirname,'../../services/billing-service/b2b-report-correction-read.candidate.sql'),'utf8'));
  return await work({...context,reportsPool});
 }finally{await reportsPool.end();await new Promise(setImmediate);assert.deepEqual(idleErrors,[],'ISOLATED_REPORTS_POOL_IDLE_ERROR');}
});
