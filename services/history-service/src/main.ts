import {bootstrapB2bHistory} from './b2b/main';
export {bootstrapB2bHistory};
// Matches the standard service image's dist/main.js contract; opt-in stays off.
if(require.main===module)void bootstrapB2bHistory().catch(()=>{process.stderr.write('B2B_HISTORY_STARTUP_BLOCKED\n');process.exitCode=1;});
