// Lectura independiente del capturador SMTP. Nunca consulta SMTP corporativo.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
if (!process.argv.includes('--isolated-only')) throw new Error('Use --isolated-only');
const proof = JSON.parse(await readFile('tmp/print-mail-live/proof.json','utf8'));
assert.match(proof.recipient,/^qa\.[a-f0-9]{8}@pruebas\.invalid$/);
assert.equal(proof.externalMail,false);
const script = `const recipient=${JSON.stringify(proof.recipient)};
async function run(){
  const list=await fetch('http://mailpit:8025/api/v1/messages',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
  const matches=list.messages.filter(m=>m.To.some(t=>t.Address===recipient));
  if(matches.length!==1) throw new Error('Captura duplicada o ausente');
  const msg=await fetch('http://mailpit:8025/api/v1/message/'+encodeURIComponent(matches[0].ID),{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
  process.stdout.write(JSON.stringify({id:msg.ID,messageId:msg.MessageID,text:msg.Text,attachments:msg.Attachments.map(a=>({filename:a.FileName,size:a.Size,sha256:a.Checksums.SHA256}))}));
} run().catch(()=>{process.stderr.write('Captura no verificable');process.exitCode=1;});`;
const result = JSON.parse(execFileSync('docker',['exec','factuez-stage2-qa-mailer-worker-1','node','-e',script],{encoding:'utf8',timeout:10000,maxBuffer:200000}));
assert.equal(result.messageId,`${proof.mailId}@factuez.invalid`);
assert.match(result.text,/CDR simulado, NO oficial/); assert.match(result.text,/no enviado a clientes/);
assert.deepEqual(result.attachments,proof.attachments.map(({filename,size,sha256})=>({filename,size,sha256})));
await writeFile('tmp/print-mail-live/capture-audit.json',JSON.stringify({...result,externalMail:false,checksumsMatched:true},null,2));
console.log('OK Mailpit independiente: exactamente una captura, dos adjuntos y ambos SHA-256 idénticos al paquete archivado.');
