'use strict';
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {withReceivedDatabase}=require('./b2b-received-db.cjs');
// The parent helper creates the NEW labelled network-none/no-ports/tmpfs PG.
// This candidate is installed exclusively inside that newly owned database.
exports.withReceivedCommandsDatabase=work=>withReceivedDatabase(async context=>{
 const ddl=readFileSync(resolve(__dirname,'../../services/received-documents-service/b2b-received-commands.candidate.sql'),'utf8');
 await context.pool.query(ddl);
 return work(context);
});


