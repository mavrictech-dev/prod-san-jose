// Verificación de código y banderas QA instalados. No lee registros/secrets.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.argv.slice(2).join(' ') !== '--read-only-qa') throw new Error('Indique --read-only-qa');
const checks = {
  'sunat-service': `
    const fs=require('node:fs'); const base='/workspace/services/sunat-service/dist/application/';
    const current=fs.readFileSync(base+'current-pdf.service.js','utf8');
    const delivery=fs.readFileSync(base+'artifact-delivery.service.js','utf8');
    const consumer=fs.readFileSync(base+'document-issued.consumer.js','utf8');
    const cache=require('/workspace/packages/pdf-renderer/dist');
    process.stdout.write(JSON.stringify({currentPdf:current.includes('/snapshot')&&current.includes('getOrRender'),
      deliveryUnderDemand:delivery.includes('this.previews.document')&&!delivery.includes('documentArtifact.find'),
      emissionWithoutPdf:!consumer.includes('renderLocalDocumentPdf')&&consumer.includes('UNSIGNED_XML'),
      memoryCache:typeof cache.PdfPreviewCache==='function'&&cache.PDF_RENDERER_VERSION==='factuez.pdf-renderer.v4',
      printEnabled:process.env.PRINT_SETTINGS_ENABLED==='true',gatesClosed:process.env.SUNAT_BETA_TRANSMISSION_ENABLED==='false'&&process.env.SUNAT_BETA_WORKFLOW_ENABLED==='false'}));`,
  'billing-service': `
    const fs=require('node:fs'); const base='/workspace/services/billing-service/dist/';
    const queries=fs.readFileSync(base+'application/issuance-query.service.js','utf8');
    const branding=fs.readFileSync(base+'application/print-branding.service.js','utf8');
    process.stdout.write(JSON.stringify({sourceFiltering:queries.includes('dataSource')&&queries.includes('startsWith:')&&queries.includes('SYNTHETIC'),
      historicalPrintBinding:queries.includes('printContext'),inactiveHistory:branding.includes('historicalRead'),
      printEnabled:process.env.PRINT_SETTINGS_ENABLED==='true',gatesClosed:process.env.FACTUEZ_DEMO_SEED==='false'}));`,
  'web-pwa': `
    const fs=require('node:fs'); const root='/workspace/apps/web-pwa/features/workspace/';
    const shell=fs.readFileSync(root+'shell.tsx','utf8'); const gre=fs.readFileSync(root+'gre-qa.tsx','utf8');
    const settings=fs.readFileSync('/workspace/apps/web-pwa/app/(workspace)/sunat-settings/page.tsx','utf8');
    const smtp=fs.readFileSync(root+'smtp-settings.tsx','utf8');
    const dashboard=fs.readFileSync('/workspace/apps/web-pwa/app/(workspace)/dashboard/page.tsx','utf8');
    const documents=fs.readFileSync('/workspace/apps/web-pwa/app/(workspace)/documents/page.tsx','utf8');
    process.stdout.write(JSON.stringify({sourceControl:shell.includes('Fuente del catálogo'),greExplicit:gre.includes('greCatalogContext')&&gre.includes('/gre-qa/capabilities')&&!gre.includes('150101'),
      credentialContext:!settings.includes('companies[0]')&&!smtp.includes('companies[0]'),
      querySource:dashboard.includes('dataSource: catalogSource')&&documents.includes('dataSource: catalogSource')}));`
};
for(const [service,probe] of Object.entries(checks)) {
  const body=execFileSync('docker',['exec',`factuez-stage2-qa-${service}-1`,'node','-e',probe],{encoding:'utf8',timeout:15000,maxBuffer:8192,windowsHide:true});
  const result=JSON.parse(body);
  for(const [key,value] of Object.entries(result)) assert.equal(value,true,`${service}: ${key}`);
  console.log(JSON.stringify({service,...result,result:'PASS',readOnly:true}));
}
