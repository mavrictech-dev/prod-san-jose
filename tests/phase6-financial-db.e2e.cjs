'use strict';
// EXPLICIT SYNTHETIC REHEARSAL. No XML/CDR bytes, PKI trust or official traffic.
// The reused helper owns a NEW labelled tmpfs PostgreSQL, network=none, no ports,
// a fixed synthetic database, and verifies ownership before removing it.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--isolated-synthetic-only']))throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const {withCorrectionDatabase}=require('./helpers/correction-reservation-db.cjs');
let stage='PREFLIGHT';const passed=[];
const check=async(label,work)=>{stage=label;await work();passed.push(label);};
withCorrectionDatabase(async({client,pool,local})=>{
  const {BetaSupplementCommandRepository}=local('./dist/application/beta-supplement-command.repository');
  const {FinancialLedgerCandidateRepository}=local('./dist/application/financial-ledger-candidate.repository');
  const {VerifiedFinancialCommit}=local('./dist/application/verified-financial-commit');
  const {VerifiedCorrectionTransaction}=local('./dist/application/verified-correction-transaction');
  const {assertBillingSupplementActivation}=local('./dist/application/beta-supplement-command.service');
  const {assertFinancialLedgerCandidateActivation}=local('./dist/application/financial-ledger-candidate.service');
  const {calculateDocumentTotals}=local('@factuez/sunat-core/dist/tax');
  const {buildFiscalNoteSnapshot,fiscalSnapshotSha256}=local('@factuez/sunat-core/dist/fiscal-note');
  const {buildFiscalSupplementCommand}=local('@factuez/sunat-core/dist/fiscal-supplement-command');
  const {projectFiscalFinancialLedger}=local('@factuez/sunat-core/dist/fiscal-financial-ledger');
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'b2b_corrections_synthetic');
  const ruc='20000000001',branch=randomUUID(),point=randomUUID(),invoice=randomUUID(),creditSeries=randomUUID(),debitSeries=randomUUID();
  await client.companySettings.create({data:{id:1,ruc,legalName:'SYNTHETIC FINANCIAL ONLY',companyType:'SYNTHETIC',economicActivities:[],taxAddress:'SYNTHETIC ADDRESS',ubigeo:'150101',contactEmails:[],environment:'BETA'}});
  await client.branch.create({data:{id:branch,companyId:1,code:'SYNTHETIC',name:'SYNTHETIC FINANCIAL ONLY'}});
  await client.emissionPoint.create({data:{id:point,companyId:1,branchId:branch,code:'0000',name:'SYNTHETIC FINANCIAL ONLY'}});
  for(const [id,type,series] of [[invoice,'INVOICE','F001'],[creditSeries,'CREDIT_NOTE','FC01'],[debitSeries,'DEBIT_NOTE','FD01']])
    await client.seriesCounter.create({data:{id,companyId:1,emissionPointId:point,documentType:type,series,nextNumber:1n}});
  const access={kind:'ASSIGNED',branchIds:[branch],emissionPointIds:[point],series:[invoice,creditSeries,debitSeries]};
  const actor={userId:null,scope:access,b2b:{kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null}};
  const scope={issuerRuc:ruc,companyId:1,branchId:branch,environment:'BETA'},now=()=> '2026-10-21T12:00:00Z';
  const authority={current:async()=>structuredClone(actor)};
  const noteOwner=new BetaSupplementCommandRepository(client),ledgerOwner=new FinancialLedgerCandidateRepository(client);
  // Composition must call the supplied transaction port; wrappers would nest it.
  noteOwner.reserve=()=>{throw new Error('NESTED_NOTE_TRANSACTION_FORBIDDEN');};
  ledgerOwner.commit=()=>{throw new Error('NESTED_LEDGER_TRANSACTION_FORBIDDEN');};
  const noteSeals=new WeakSet(),noteEvidence={verify:async command=>{
    const proof={commandSha256:fiscalSnapshotSha256(command),evidenceSha256:'a'.repeat(64)};
    noteSeals.add(proof);return proof;
  },owns:value=>!!value&&typeof value==='object'&&noteSeals.has(value)};
  const reservations=new VerifiedCorrectionTransaction(client,authority,noteEvidence,[ruc],now);
  const evidenceByOperation=new Map(),outcomeSeals=new WeakSet(),prerequisiteSeals=new WeakSet(),originalSeals=new WeakSet();
  const outcomes={
    command:async operationId=>{
      const rows=await client.outboxEvent.findMany({where:{aggregateId:operationId,eventType:'billing.beta.supplement.requested.v1'},select:{payload:true},take:2});
      assert.equal(rows.length,1,'OWN_SYNTHETIC_COMMAND_REQUIRED');return rows[0].payload;
    },
    prerequisites:async command=>{
      const proof={commandSha256:fiscalSnapshotSha256(command),evidenceSha256:fiscalSnapshotSha256(command.payload.envelope.context)};
      prerequisiteSeals.add(proof);return proof;
    },
    ownsPrerequisites:value=>!!value&&typeof value==='object'&&prerequisiteSeals.has(value),
    original:async snapshot=>{
      const proof={evidence:{documentId:snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(snapshot),issuerRuc:snapshot.issuer.identityNumber,environment:snapshot.environment},fence:{snapshotSha256:fiscalSnapshotSha256(snapshot),revision:1,fixtureOnly:true}};originalSeals.add(proof);return proof;
    },
    ownsOriginal:value=>!!value&&typeof value==='object'&&originalSeals.has(value),
    verify:async command=>{
      const evidence=evidenceByOperation.get(command.payload.operationId);assert.ok(evidence,'SYNTHETIC_OUTCOME_REQUIRED');
      const proof={commandSha256:fiscalSnapshotSha256(command),operationId:command.payload.operationId,
        evidence:structuredClone(evidence),fence:{revision:1,fixtureOnly:true}};
      outcomeSeals.add(proof);return proof;
    },
    owns:value=>!!value&&typeof value==='object'&&outcomeSeals.has(value),
  };
  const financial=()=>new VerifiedFinancialCommit(client,ledgerOwner,outcomes,authority,now);
  let sequence=0;
  async function original(){
    const id=randomUUID(),number=String(++sequence),doc={documentId:id,companyId:1,branchId:branch,environment:'BETA',documentTypeCode:'01',series:'F001',number,fullNumber:'F001-'+number,
      issueDate:'2026-10-20T10:00:00Z',currencyCode:'PEN',operationTypeCode:'0101',paymentTerms:{type:'CONTADO'},
      issuer:{identityType:'6',identityNumber:ruc,legalName:'SYNTHETIC FINANCIAL ONLY',address:'SYNTHETIC ADDRESS',ubigeo:'150101',establishmentCode:'0000'},
      customer:{identityType:'6',identityNumber:ruc,legalName:'SYNTHETIC FINANCIAL ONLY'},
      ...calculateDocumentTotals([{description:'SYNTHETIC ITEM',productCode:'SYNTHETIC',unitCode:'NIU',quantity:'2',unitPriceWithTax:'118',taxAffectationCode:'10',igvRate:'18'}])};
    await client.document.create({data:{id,companyId:1,seriesCounterId:invoice,type:'INVOICE',status:'ISSUED',sunatStatus:'ACCEPTED',series:doc.series,number:BigInt(number),fullNumber:doc.fullNumber,
      issueDate:new Date(doc.issueDate),currencyCode:'PEN',operationTypeCode:'0101',emissionPointId:point,createdByUserId:randomUUID(),customerIdentityType:'6',customerIdentityNumber:ruc,
      customerLegalName:'SYNTHETIC FINANCIAL ONLY',...doc.totals,immutableSnapshot:doc}});
    return doc;
  }
  async function command(doc,{debit=false,history=[]}={}){
    const context={original:doc,acceptance:{environment:'BETA',issuerRuc:ruc,documentId:doc.documentId,documentTypeCode:'01',fullNumber:doc.fullNumber,
      snapshotSha256:fiscalSnapshotSha256(doc),cdrSha256:'a'.repeat(64),status:'ACCEPTED',responseCode:'0',acceptedAt:'2026-10-20T10:05:00Z',source:{kind:'CDR_DOCUMENT'}},
      asOf:'2026-10-20T10:20:00Z',creditHistory:{complete:true,entries:history.map(note=>({state:'RESERVED',note}))}};
    const counter=await client.seriesCounter.findUniqueOrThrow({where:{id:debit?debitSeries:creditSeries}});
    const note=buildFiscalNoteSnapshot(context,debit
      ?{documentTypeCode:'08',reasonCode:'02',reasonDescription:'SYNTHETIC DELTA',lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'11.8'}]}
      :{documentTypeCode:'07',reasonCode:'07',reasonDescription:'SYNTHETIC RETURN',lines:[{originalLineNumber:1,quantity:'1'}]},
      {documentId:randomUUID(),series:counter.series,number:counter.nextNumber.toString(),issueDate:'2026-10-20T10:10:00Z'});
    return buildFiscalSupplementCommand({kind:'NOTE',note,context},{eventId:randomUUID(),correlationId:randomUUID(),occurredAt:context.asOf});
  }
  async function reserve(c){return reservations.execute(c,(tx,cmd,a)=>noteOwner.reserveWithinTransaction(tx,cmd,a));}
  const basePlan=(doc,commands=[])=>({planId:randomUUID(),input:{scope,documents:[structuredClone(doc)],entries:[],
    reservations:commands.filter(c=>c.payload.envelope.note.documentTypeCode==='07').map(c=>({operationId:c.payload.operationId,documentId:doc.documentId,
      note:structuredClone(c.payload.envelope.note),noteContext:structuredClone(c.payload.envelope.context)}))},
    expectedHeads:[{documentId:doc.documentId,revision:0,sequence:0,versionSha256:null}]});
  function settle(base,c,{status='ACCEPTED',responseCode=status==='REJECTED'?'2335':'0'}={}){
    const plan=structuredClone(base),projection=projectFiscalFinancialLedger(plan.input);assert.equal(projection.ok,true,'VALID_SYNTHETIC_BASE_REQUIRED');
    const head=projection.documents[0],evidence={status,cdrSignatureVerified:true,officialCdr:true,responseCode,cdrSha256:'b'.repeat(64),requestSha256:'c'.repeat(64),acceptedAt:'2026-10-20T10:30:00Z'};
    evidenceByOperation.set(c.payload.operationId,structuredClone(evidence));
    plan.planId=randomUUID();plan.expectedHeads=[{documentId:head.documentId,revision:head.currentVersion.revision,sequence:head.lastSequence,versionSha256:head.currentVersion.sha256}];
    plan.input.entries.push({...scope,documentId:head.documentId,eventId:randomUUID(),operationId:c.payload.operationId,sequence:head.lastSequence+1,
      expectedPreviousSha256:head.currentVersion.sha256,kind:c.payload.envelope.note.documentTypeCode==='07'?'NOTE_CREDIT':'NOTE_DEBIT',nextSnapshot:structuredClone(c.payload.envelope.note),
      noteContext:{...structuredClone(c.payload.envelope.context),asOf:'2026-10-21T11:00:00Z'},evidence});
    return plan;
  }
  const head=id=>client.financialLedgerStream.findUniqueOrThrow({where:{documentId:id}});
  async function financialState(){return {
    commits:await client.financialLedgerCommit.findMany({orderBy:{planId:'asc'}}),heads:await client.financialLedgerStream.findMany({orderBy:{documentId:'asc'}}),
    versions:await client.financialLedgerVersion.findMany({orderBy:[{documentId:'asc'},{revision:'asc'}]}),entries:await client.financialLedgerEntry.findMany({orderBy:[{documentId:'asc'},{sequence:'asc'}]}),
  };}
  // Settlement must never modify business originals, numbering, note state or Outbox.
  async function fiscalState(){return {
    documents:await client.document.findMany({orderBy:{id:'asc'}}),counters:await client.seriesCounter.findMany({orderBy:{id:'asc'}}),
    outbox:await client.outboxEvent.findMany({orderBy:{id:'asc'}}),items:await client.documentItem.findMany({orderBy:{id:'asc'}}),
    taxes:await client.documentTax.findMany({orderBy:{id:'asc'}}),references:await client.documentReference.findMany({orderBy:{id:'asc'}}),
  };}
  async function pending({debit=false}={}){
    const doc=await original(),c=await command(doc,{debit});await reserve(c);
    const base=basePlan(doc,[c]);await financial().commit(base,actor);return {doc,c,base,plan:settle(base,c)};
  }
  await check('PUBLIC_GATES_REMAIN_CLOSED',async()=>{
    assert.throws(assertBillingSupplementActivation,/Productor fiscal BETA bloqueado/);
    assert.throws(assertFinancialLedgerCandidateActivation,/Persistencia candidata BETA bloqueada/);
  });
  let first;
  await check('REAL_OWNER_RESERVATION_PRESERVES_NULL_HUMAN_SERVICE_AND_BASE_RESERVATION',async()=>{
    first=await pending();const note=await client.document.findUniqueOrThrow({where:{id:first.c.payload.operationId}});
    assert.equal(note.createdByUserId,null);assert.equal(note.createdByActor.kind,'SERVICE');assert.equal(note.createdByActor.subjectId,null);
    assert.equal(note.sunatStatus,'QUEUED');const h=await head(first.doc.documentId);
    assert.equal(h.currentVersion.net.payableAmount,'236.00');assert.equal(h.currentVersion.creditCapacity.payableAmount,'118.00');assert.equal(h.revision,0);
  });
  await check('ACCEPTED_OWNER_OUTCOME_COMMITS_SEPARATE_LEDGER_WITHOUT_FISCAL_MUTATIONS',async()=>{
    const before=await fiscalState(),result=await financial().commit(first.plan,actor),h=await head(first.doc.documentId);
    assert.equal(result.candidateOnly,true);assert.equal(result.fiscalAuthority,false);assert.equal(result.evidenceAuthenticityVerified,false);assert.equal(result.transmissionAuthorized,false);
    assert.equal(result.deduplicated,false);assert.equal(h.revision,1);assert.equal(h.sequence,1);assert.equal(h.currentVersion.net.payableAmount,'118.00');
    assert.equal(h.originalSnapshot.totals.payableAmount,'236.00');assert.deepEqual(await fiscalState(),before);
  });
  await check('RESTART_EXACT_REPLAY_REAUTHORIZES_WITHOUT_DUPLICATING_OR_REWINDING',async()=>{
    const before=await financialState(),source=await fiscalState();
    const restartedOwner=new FinancialLedgerCandidateRepository(client);restartedOwner.commit=()=>{throw new Error('NESTED_TRANSACTION_FORBIDDEN');};
    const restarted=new VerifiedFinancialCommit(client,restartedOwner,outcomes,authority,now);
    assert.equal((await restarted.commit(first.plan,actor)).deduplicated,true);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
    const denied={...actor,scope:{...access,series:[]}};
    await assert.rejects(financial().commit(first.plan,denied),/FINANCIAL_AUTHORITY_CHANGED/);assert.deepEqual(await financialState(),before);
  });
  await check('CONCURRENT_EXACT_SETTLEMENT_HAS_ONE_EFFECT_AND_STABLE_REPLAYS',async()=>{
    const p=await pending(),before=await fiscalState();
    const results=await Promise.all(Array.from({length:4},()=>financial().commit(p.plan,actor)));
    assert.equal(results.filter(r=>!r.deduplicated).length,1);assert.equal(results.filter(r=>r.deduplicated).length,3);
    assert.equal(await client.financialLedgerEntry.count({where:{documentId:p.doc.documentId}}),1);
    assert.equal((await head(p.doc.documentId)).currentVersion.net.payableAmount,'118.00');assert.deepEqual(await fiscalState(),before);
  });
  await check('DISTINCT_PLAN_IDS_ON_SAME_CHECKPOINT_CANNOT_DOUBLE_SETTLE',async()=>{
    const p=await pending(),other={...structuredClone(p.plan),planId:randomUUID()},before=await fiscalState();
    const results=await Promise.allSettled([financial().commit(p.plan,actor),financial().commit(other,actor)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
    assert.match(results.find(r=>r.status==='rejected').reason.message,/STALE_HEAD/);
    assert.equal(await client.financialLedgerEntry.count({where:{documentId:p.doc.documentId}}),1);assert.deepEqual(await fiscalState(),before);
  });
  await check('REJECTED_OUTCOME_ADVANCES_SEQUENCE_WITHOUT_EFFECT_OR_RESERVATION_RELEASE',async()=>{
    const p=await pending(),rejected=settle(p.base,p.c,{status:'REJECTED'}),before=await fiscalState();
    await financial().commit(rejected,actor);const h=await head(p.doc.documentId);
    assert.equal(h.revision,0);assert.equal(h.sequence,1);assert.equal(h.currentVersion.net.payableAmount,'236.00');assert.equal(h.currentVersion.creditCapacity.payableAmount,'118.00');
    assert.equal(await client.financialLedgerVersion.count({where:{documentId:p.doc.documentId}}),1);
    assert.equal((await client.financialLedgerEntry.findFirstOrThrow({where:{documentId:p.doc.documentId}})).outcome,'REJECTED');assert.deepEqual(await fiscalState(),before);
  });
  await check('ACCEPTED_DEBIT_HAS_EXACT_DECIMAL_EFFECT_WITHOUT_INCREASING_CREDIT_CAPACITY',async()=>{
    const p=await pending({debit:true}),before=await fiscalState();await financial().commit(p.plan,actor);const h=await head(p.doc.documentId);
    assert.equal(h.revision,1);assert.equal(h.currentVersion.net.payableAmount,'259.60');assert.equal(h.currentVersion.creditCapacity.payableAmount,'236.00');
    assert.deepEqual(await fiscalState(),before);
  });
  await check('FAILURE_AFTER_REAL_LEDGER_WRITES_ROLLS_BACK_ALL_CANDIDATE_ROWS',async()=>{
    const p=await pending(),before=await financialState(),source=await fiscalState();
    const failing={commitWithinTransaction:async(...args)=>{await ledgerOwner.commitWithinTransaction(...args);throw new Error('SYNTHETIC_POST_WRITE_FAILURE');}};
    await assert.rejects(new VerifiedFinancialCommit(client,failing,outcomes,authority,now).commit(p.plan,actor),/SYNTHETIC_POST_WRITE_FAILURE/);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('OWNER_TRANSACTION_COMMIT_FAILURE_ROLLS_BACK_ALL_CANDIDATE_ROWS',async()=>{
    const p=await pending(),before=await financialState(),source=await fiscalState();
    const failCommit={$transaction:(work,options)=>client.$transaction(async tx=>{await work(tx);throw new Error('SYNTHETIC_COMMIT_FAILURE');},options)};
    await assert.rejects(new VerifiedFinancialCommit(failCommit,ledgerOwner,outcomes,authority,now).commit(p.plan,actor),/SYNTHETIC_COMMIT_FAILURE/);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('REVOCATION_IMMEDIATELY_PRECOMMIT_ROLLS_BACK_REAL_POSTGRESQL_WRITES',async()=>{
    const p=await pending(),before=await financialState(),source=await fiscalState();let calls=0;
    const revoking={current:async()=>{if(++calls===3)throw new Error('SYNTHETIC_REVOKED');return structuredClone(actor);}};
    await assert.rejects(new VerifiedFinancialCommit(client,ledgerOwner,outcomes,revoking,now).commit(p.plan,actor),/SYNTHETIC_REVOKED/);
    assert.equal(calls,3);assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('EVIDENCE_FENCE_CHANGE_PRECOMMIT_ROLLS_BACK_REAL_POSTGRESQL_WRITES',async()=>{
    const p=await pending(),before=await financialState(),source=await fiscalState();let calls=0;
    const changing={...outcomes,verify:async(...args)=>{const proof=await outcomes.verify(...args);if(++calls===3)proof.fence.revision++;return proof;}};
    await assert.rejects(new VerifiedFinancialCommit(client,ledgerOwner,changing,authority,now).commit(p.plan,actor),/FINANCIAL_EVIDENCE_CHANGED/);
    assert.equal(calls,3);assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('PUBLIC_FLAGS_OR_COPIED_PROOF_CANNOT_AUTHORIZE_SETTLEMENT',async()=>{
    const p=await pending(),before=await financialState(),source=await fiscalState();
    const forged={...outcomes,verify:async(...args)=>structuredClone(await outcomes.verify(...args))};
    await assert.rejects(new VerifiedFinancialCommit(client,ledgerOwner,forged,authority,now).commit(p.plan,actor),/VERIFIED_OWN_OUTCOME_REQUIRED/);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('PREREQUISITES_EVIDENCE_CHANGE_PRECOMMIT_ROLLS_BACK_SETTLEMENT',async()=>{
    const p=await pending(),before=await financialState(),source=await fiscalState();let calls=0;
    const changing={...outcomes,prerequisites:async(...args)=>{const proof=await outcomes.prerequisites(...args);if(++calls===3)proof.evidenceSha256='0'.repeat(64);return proof;}};
    await assert.rejects(new VerifiedFinancialCommit(client,ledgerOwner,changing,authority,now).commit(p.plan,actor),/FINANCIAL_EVIDENCE_CHANGED/);
    assert.equal(calls,3);assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('BASE_ONLY_WITHOUT_ORIGINAL_OWNER_PROVENANCE_IS_NOT_ACCEPTED',async()=>{
    const doc=await original(),base=basePlan(doc),before=await financialState(),source=await fiscalState();
    const forged={...outcomes,original:async(...args)=>structuredClone(await outcomes.original(...args))};
    await assert.rejects(new VerifiedFinancialCommit(client,ledgerOwner,forged,authority,now).commit(base,actor),/VERIFIED_ORIGINAL_REQUIRED/);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('ADDING_RESERVATIONS_TO_FROZEN_BASE_IS_EXPLICITLY_UNSUPPORTED_NOT_RELAXED',async()=>{
    const doc=await original(),base=basePlan(doc);await financial().commit(base,actor);
    const c=await command(doc);await reserve(c);const changed=basePlan(doc,[c]),stored=await head(doc.documentId);
    changed.expectedHeads=[{documentId:doc.documentId,revision:stored.revision,sequence:stored.sequence,versionSha256:stored.versionSha256}];
    const before=await financialState(),source=await fiscalState();
    await assert.rejects(financial().commit(changed,actor),/RESERVATIONS_IMMUTABLE/);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('OWN_SNAPSHOT_TAMPERING_IS_DETECTED_NOT_REPAIRED',async()=>{
    const p=await pending();await client.document.update({where:{id:p.c.payload.operationId},data:{payableAmount:'119.00'}});
    const before=await financialState(),source=await fiscalState();await assert.rejects(financial().commit(p.plan,actor),/OWN_SNAPSHOT_MISMATCH/);
    assert.deepEqual(await financialState(),before);assert.deepEqual(await fiscalState(),source);
  });
  await check('FINAL_NO_DISPATCH_NO_OFFICIAL_EVIDENCE_NO_BUSINESS_RUNTIME_CHANGES',async()=>{
    assert.ok((await client.outboxEvent.findMany({select:{publishedAt:true}})).every(e=>e.publishedAt===null));
    assert.equal(await client.dailySummary.count(),0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bCorrectionHold"')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "B2bCorrectionHoldHead"')).rows[0].n,0);
  });
  await check('BILLING_PRIVATE_EVIDENCE_SCOPE_AND_COMMAND_READER_USE_OWN_PRISMA_ONLY',async()=>{
    const {PrismaCorrectionEvidenceScope}=local('./dist/b2b/correction-evidence-authority'),{BillingCorrectionEvidenceCommandReader}=local('./dist/b2b/correction-evidence-assembly');
    const {correctionEvidenceRequest}=local('@factuez/service-access/dist/b2b-correction-evidence-wire');
    const binding={reference:{issuerId:1,issuerRuc:ruc,environment:'BETA',branchId:branch,pointId:point,seriesId:invoice,documentType:'01'},noteSeriesId:creditSeries,noteType:'07'};
    const request=correctionEvidenceRequest({schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:randomUUID(),kind:'SERVICE',action:'OUTCOME',binding,asOf:now(),payload:first.c});
    const before=await fiscalState(),financialBefore=await financialState(),ownScope=new PrismaCorrectionEvidenceScope(client);
    assert.match(await ownScope.inspect(request,actor),/^[a-f0-9]{64}$/);
    const identityFixture={current:async()=>({actor:structuredClone(actor),clientRevision:1,grantRevision:1,candidateOnly:true,fiscalExecutionEnabled:false})};
    const reader=new BillingCorrectionEvidenceCommandReader(client,identityFixture,async()=> 'synthetic-token','SERVICE',binding,now);
    assert.deepEqual(await reader.load(first.c.payload.operationId),first.c);
    await assert.rejects(ownScope.inspect({...request,binding:{...binding,reference:{...binding.reference,pointId:randomUUID()}}},actor));
    assert.deepEqual(await fiscalState(),before);assert.deepEqual(await financialState(),financialBefore);
  });
}).then(()=>console.log(JSON.stringify({result:'PASS',passed,officialNetwork:false,realData:false,qaRuntimeChanged:false,
  proofSource:'SEALED_SYNTHETIC_FIXTURE_ONLY',pkiTrustVerified:false,
  limits:['Candidate ledger only; does not update fiscal documents or authorize dispatch.','Initial reservation sets remain immutable; adding later reservations requires a separate reviewed protocol.']})))
  .catch(e=>{console.error(JSON.stringify({result:'FAIL',stage,code:e?.code??null,model:typeof e?.meta?.modelName==='string'?e.meta.modelName:null,uniqueTarget:Array.isArray(e?.meta?.target)?e.meta.target:null,reason:e?.name??'FAILURE',detail:e?.code?null:String(e?.message??'FAILURE').slice(0,200),qaRuntimeChanged:false}));process.exitCode=1;});
