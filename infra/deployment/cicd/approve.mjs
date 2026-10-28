import {readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {digest,validateRelease} from './release.mjs';
// Local TI action, never invoked by GitHub Actions or by the SSH forced command.
try{
 const args=process.argv.slice(2);
 if(args.length!==6||args[3]!=='--schema-compatible'||args[4]!=='--rollback-compatible'||args[5]!=='--backup-restore-verified')throw Error('EXPLICIT_COMPATIBILITY_AND_BACKUP_RESTORE_REVIEW_REQUIRED');
 const [configFile,releaseFile,backupReceipt]=args,config=JSON.parse(readFileSync(configFile,'utf8')),bytes=readFileSync(releaseFile),r=JSON.parse(bytes);
 validateRelease(r,config.registryPrefix);
 if(!backupReceipt.startsWith('/srv/')||realpathSync(backupReceipt)!==backupReceipt||!lstatSync(backupReceipt).isFile()||lstatSync(backupReceipt).isSymbolicLink())throw Error('LOCAL_BACKUP_RECEIPT_REQUIRED');
 const receipt=JSON.parse(readFileSync(backupReceipt,'utf8'));
 if(receipt.backupVerified!==true||receipt.restoreVerified!==true||!Number.isFinite(Date.parse(receipt.verifiedAt))||Date.now()-Date.parse(receipt.verifiedAt)>86400000||Date.parse(receipt.verifiedAt)>Date.now())throw Error('CURRENT_VERIFIED_BACKUP_RECEIPT_REQUIRED');
 const hash=digest(bytes),out=path.join(config.directory,'approvals',hash+'.json');
 writeFileSync(out,JSON.stringify({releaseSha256:hash,schemaCompatible:true,rollbackCompatible:true,backupVerified:true,backupVerifiedAt:receipt.verifiedAt,backupReference:backupReceipt,expiresAt:new Date(Date.now()+90*60000).toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('APPROVED_RELEASE_SHA256='+hash);
}catch(e){console.error(/^[A-Z_]+$/.test(e.message)?e.message:'LOCAL_APPROVAL_FAILED');process.exitCode=1;}
