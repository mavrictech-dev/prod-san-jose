'use strict';
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {withReceivedCommandsDatabase}=require('./b2b-received-commands-db.cjs');
exports.withReceivedAutomationDatabase=work=>withReceivedCommandsDatabase(async c=>{
 await c.pool.query(readFileSync(resolve(__dirname,'../../services/received-documents-service/b2b-received-automation.candidate.sql'),'utf8'));
 return work(c);
});
