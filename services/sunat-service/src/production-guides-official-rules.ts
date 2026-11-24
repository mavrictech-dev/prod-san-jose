import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {HYDROCARBON_RULES,productionGuidesBytesHash} from '@factuez/sunat-core/dist/production-guides';
/** Fixed local process, bounded input/output/time. No configurable script or shell. */
export function validateOfficialGreXml(xml:string,filename:string,check=false):Promise<void>{
 return new Promise((resolve,reject)=>{
  const child=spawn(process.platform==='win32'?'python':'python3',[join(__dirname,'../assets/sunat/validate-gre.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',errors='',done=false;const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
  const timer=setTimeout(()=>{child.kill();finish(Error('Validador XSL SUNAT excedió el tiempo permitido'));},15000);
  child.stdout.on('data',b=>{output+=b.toString();if(output.length>128000){child.kill();finish(Error('Salida XSL excedida'));}});
  child.stderr.on('data',b=>{errors+=b.toString();if(errors.length>16000)child.kill();});
  child.on('error',()=>finish(Error('Validador XSL SUNAT no disponible: instale Python 3 y lxml')));
  child.stdin.on('error',()=>finish(Error('Validador XSL SUNAT no disponible')));
  child.on('close',code=>{try{if(code!==0)throw Error(errors.slice(0,2000)||'Validación XSL SUNAT falló');const p=JSON.parse(output);if(p.validated!==true||p.configurationOnly!==check||p.xslSha256!==HYDROCARBON_RULES.xslSha256||p.xmlSha256!==productionGuidesBytesHash(xml)||p.commonsSha256!=='49a63e59375700c729930e10a69228b9604b1cd792d713de8068e543a68b4a5c'||p.xsdSha256!==HYDROCARBON_RULES.xsdArchiveSha256)throw Error('Prueba de reglas SUNAT no coincide: '+JSON.stringify({actual:p,expected:{xml:productionGuidesBytesHash(xml),xsl:HYDROCARBON_RULES.xslSha256,xsd:HYDROCARBON_RULES.xsdArchiveSha256}}));if(p.warnings.length)throw Error('XML observado por reglas SUNAT: '+JSON.stringify(p.warnings));finish();}catch(e){finish(e instanceof Error?e:Error('Prueba XSL inválida'));}});
  child.stdin.end(JSON.stringify({xml,filename,check}));
 });
}

export const officialGreRulesConfigured=()=>validateOfficialGreXml('','00000000000-09-T000-1.xml',true);
