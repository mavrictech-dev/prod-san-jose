'use strict';
const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),{join,resolve}=require('node:path');
const req=createRequire(process.env.TEST_IDENTITY_PACKAGE||resolve(__dirname,'../services/identity-service/package.json'));
req('reflect-metadata');const {RbacBootstrapService}=req('./dist/application/rbac-bootstrap.service'),{PasswordService}=req('./dist/application/password.service');
const dir=mkdtempSync(join(tmpdir(),'factuez-admin-synthetic-')),file=join(dir,'password'),password='Synthetic-only-unit-password-2026';writeFileSync(file,password,{mode:0o600});
const users=new Map(),calls=[];const prisma={user:{findUnique:async({where})=>users.get(where.username)||null,create:async({data})=>{users.set(data.username,data);calls.push(data);return data;}},role:{findUniqueOrThrow:async()=>({id:'admin-role-synthetic'})}};
(async()=>{try{
 const service=new RbacBootstrapService(prisma,new PasswordService());
 process.env.INITIAL_ADMIN_USERNAME='synthetic.admin';process.env.INITIAL_ADMIN_FULL_NAME='SYNTHETIC ADMIN';process.env.INITIAL_ADMIN_PASSWORD_FILE=file;
 await service.provisionInitialAdministrator();assert.equal(calls.length,1);assert.equal(calls[0].fullName,'SYNTHETIC ADMIN');assert.equal(calls[0].roles.create.roleId,'admin-role-synthetic');assert.notEqual(calls[0].passwordHash,password);assert.ok(await new PasswordService().verify(password,calls[0].passwordHash));
 writeFileSync(file,'Different-synthetic-password-2026');await service.provisionInitialAdministrator();assert.equal(calls.length,1);assert.ok(await new PasswordService().verify(password,calls[0].passwordHash));
 process.env.INITIAL_ADMIN_USERNAME='';await service.provisionInitialAdministrator();assert.equal(calls.length,1);
 console.log(JSON.stringify({result:'PASS',newAdminRole:true,scrypt:true,restartDoesNotOverwritePassword:true,disabledBootstrapCreatesNoAccount:true,realDatabase:false}));
 }catch(e){console.error('INITIAL_ADMIN_REHEARSAL_FAILED');process.exitCode=1;}finally{for(const k of ['INITIAL_ADMIN_USERNAME','INITIAL_ADMIN_FULL_NAME','INITIAL_ADMIN_PASSWORD_FILE'])delete process.env[k];assert.ok(dir.startsWith(join(tmpdir(),'factuez-admin-synthetic-')));rmSync(dir,{recursive:true,force:true});}})();
