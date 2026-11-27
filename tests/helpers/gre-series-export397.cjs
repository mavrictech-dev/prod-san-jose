'use strict';
// Offline baseline export pinned to published397. No module migration or updater
// currently under development can enter this fixture or its migration ledger.
const {spawnSync}=require('node:child_process'),Module=require('node:module'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const read=file=>{const r=spawnSync('git',['show','397530d0a38d3d07e2e75a9a7d0f626da41e9a9c:'+file],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});assert.equal(r.status,0,'PUBLISHED_SCHEMA_SOURCE_REQUIRED');return r.stdout;};
const compile=(file,source)=>{const m=new Module(path.join(root,file),module);m.filename=path.join(root,file);m.paths=Module._nodeModulePaths(path.dirname(m.filename));m._compile(source,m.filename);return m.exports;};
const updater=compile('scripts/update-igv-catalogs-gre.cjs',read('scripts/update-igv-catalogs-gre.cjs')),load=Module._load;
Module._load=function(request,parent,isMain){if(request==='./update-igv-catalogs-gre.cjs'&&parent?.filename===path.join(root,'scripts/export-production-schemas.cjs'))return updater;return load.apply(this,arguments);};
try{compile('scripts/export-production-schemas.cjs',read('scripts/export-production-schemas.cjs'));}finally{Module._load=load;}
const windows=read('scripts/export-windows-test-schemas.cjs');
const prefix="const {readFileSync,writeFileSync,chmodSync}=require('node:fs');const {join}=require('node:path');const {createHash}=require('node:crypto');const target=process.argv[2];\n";
compile('scripts/export-windows-test-schemas.cjs',prefix+windows.slice(windows.indexOf('const extra={')));
const fs=require('node:fs'),billing=fs.readFileSync(path.join(process.argv[2],'billing-service.sql'),'utf8');assert.ok(!billing.includes('GreSeriesAdministrationJournal'),'UNPUBLISHED_MODULE_SCHEMA_FORBIDDEN');
