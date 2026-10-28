import 'reflect-metadata';
/** Separate executable: disabled means no mounts, DI, secrets, database or sockets. */
export async function bootstrapB2bIdentity(){
 if(process.env.B2B_IDENTITY_ENABLED!=='true')return null;
 const {startB2bIdentityHost}=await import('./runtime-host');
 return startB2bIdentityHost();
}
if(require.main===module)void bootstrapB2bIdentity().catch(()=>{process.stderr.write('B2B_IDENTITY_STARTUP_BLOCKED\n');process.exitCode=1;});
