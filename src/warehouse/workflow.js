import {bootId,makeCheckpoint,validateCheckpoint} from './checkpoint.js';
import {historyProjection,summarizeRun,historyOverview} from './history.js';
import {materializeContextTask,materializeDeepTask,materializeLogisticsTask,materializeRegistryTask} from './context-task.js';
import {randomUUID} from 'node:crypto';
import {catalog,packaging,profiles,hash,checkConfig,effectiveConfig} from './reference.js';
import {processFile,delimiterFor,createReferenceContext} from './domain.js';
import {materialize} from './generator.js';
import {generate,modelRequest,agentTools,agentInput,decodeConfig,encodeConfig,selectAgentTools} from './model.js';
import {evaluateFile,gate,publicMetrics,assess,procedureGuard} from './evaluator.js';
import {compareArchitecture,compactContext,policies,needsAdaptation,referenceReuseProfile} from './architecture.js';
import {prepare,publicRun,persistRun,commit,proof} from './store.js';
const isContext=s=>['context-challenge','context-deep','context-logistics','context-registry'].includes(s);
const terminal=new Set(['COMPLETED','COMPLETED_NO_IMPROVEMENT','FAILED','STOPPED_BUDGET','STOPPED_CUTOFF','CANCELLED','COMMIT_UNKNOWN','SUSPENDED']);
const diagnostics=results=>({pipelineProfile:results.stats||null,counts:Object.fromEntries(['ACCEPT','REJECT','QUARANTINE','SKIP_DUPLICATE'].map(d=>[d,results.filter(x=>x.decision===d).length])),issues:results.filter(x=>x.decision!=='ACCEPT').slice(0,12).map(x=>({line:x.line,decision:x.decision,reason:x.reason,source:x.source}))});
export function mountWarehouse(app,{mongo,budget,getBusy,setBusy}){
 const runs=new Map(),listeners=new Map();
 const find=async id=>runs.has(id)?publicRun(runs.get(id)):await mongo?.db('importforge').collection('warehouse_runs').findOne({_id:id},{projection:{_id:0,expectedRecords:0,committedKeys:0}});
 function attach(run){
  run.deadline=Date.now()+(run.remainingMs??600000);
  run.check=()=>{if(run.cancelled)throw new Error('CANCELLED');if(Date.now()>run.deadline)throw new Error('RUN_TIME_LIMIT');if(new Date()>new Date('2026-10-12T00:00:00Z'))throw new Error('cutoff reached');};
  run.event=async(step,details)=>{run.stage=step;run.budget=budget.status();const event={seq:run.events.length+1,runId:run.id,at:new Date().toISOString(),step,...details};run.events.push(event);for(const stream of listeners.get(run.id)||[])stream.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);if(run.db)await persistRun(run.db,run);};
 }
 async function execute(run,params,checkpoint=null){
  let db,committing=false,committed=false;const privateState={batch:null,inspected:new Set(),profileRead:new Set(),history:null,current:null,chosen:null,proposalHashes:new Set(),feedbackId:null,feedback:null};
  try{
   await run.event('preflight',{});await mongo.connect();db=mongo.db('importforge');await db.command({ping:1});const active=await prepare(db);const previous=checkpoint?.previous||active;run.check();
   if(checkpoint){
    privateState.batch=await db.collection('warehouse_batches').findOne({_id:run.id});delete privateState.batch._id;delete privateState.batch.createdAt;
    const suspended={...run,status:'SUSPENDED'};validateCheckpoint(checkpoint,suspended,privateState.batch,active);
    Object.assign(privateState,checkpoint.state,{batch:privateState.batch,inspected:new Set(checkpoint.state.inspected),profileRead:new Set(checkpoint.state.profileRead),proposalHashes:new Set(checkpoint.state.proposalHashes)});
    run.db=db;run.horizon={...run.horizon,resumedAt:new Date().toISOString(),resumedBootId:bootId,restartVerified:checkpoint.bootId!==bootId,resumeCount:1};
    await run.event('task_resumed',{taskId:run.id,completedFiles:checkpoint.progress.completedFiles,nextFile:'C',checkpointHash:checkpoint.hash,oldBootId:checkpoint.bootId,newBootId:bootId,restartVerified:checkpoint.bootId!==bootId,modelRequestsCarried:run.modelRequests,toolCallsCarried:run.toolCalls,feedbackId:privateState.feedbackId,historyHash:hash(privateState.history),remainingMs:checkpoint.remainingMs});
   }else {run.startingVersion=previous.version;run.version=previous.version;run.beforeConfig=effectiveConfig(previous.config);run.config=effectiveConfig(previous.config);privateState.chosen=run.config;run.db=db;run.architectureRevision=2;run.contextChanges=[];
   await run.event('harness_loaded',{version:previous.version,reference:'warehouse_reference/v1'});
   const plan=await generate(run,budget,params);run.check();privateState.batch=(params.scenario==='context-registry'?materializeRegistryTask:params.scenario==='context-logistics'?materializeLogisticsTask:params.scenario==='context-deep'?materializeDeepTask:isContext(params.scenario)?materializeContextTask:materialize)(plan,{runId:run.id,count:params.count,seed:params.seed});
   await db.collection('warehouse_batches').insertOne({_id:run.id,...privateState.batch,createdAt:run.createdAt});
   run.generation={title:plan.title,planHash:privateState.batch.planHash,aiGenerated:true,materializer:privateState.batch.materializer};
   run.files=privateState.batch.files.map(({expected,raw,...f})=>({...f,preview:raw.split(/\r?\n/).slice(0,7).join('\n')}));
   await run.event('files_materialized',{files:run.files.map(x=>({id:x.id,rows:x.rowCount,hash:x.hash})),origin:'Azure generation plan → deterministic CSV materialization'});
   run.referenceReuse=referenceReuseProfile(privateState.batch.files,privateState.chosen);run.batchBaseline=privateState.batch.files.map(f=>({fileId:f.id,...publicMetrics(evaluateFile(f,privateState.chosen).metrics)}));await run.event('reference_reuse_profile',run.referenceReuse);
   const fileA=privateState.batch.files[0];run.baselineMetrics=publicMetrics(evaluateFile(fileA,previous.config).metrics);await run.event('baseline',{fileId:'A',...run.baselineMetrics});
   }
   const fileA=privateState.batch.files[0],fileB=privateState.batch.files[1];
   async function reviewFailure(file,metrics){
    if(!run.pauseOnFailure||metrics.correct===metrics.total||run.attempts.length>=2||run.modelRequests>=7)return;
    run.waitingFor=file.id;await run.event('live_review_paused',{fileId:file.id,metrics,diagnostics:diagnostics(processFile(file,privateState.chosen)),procedure:privateState.chosen.procedure,note:'Actual execution failed. No importer request or stock commit is made while this review point is paused.'});
    try{await new Promise((resolve,reject)=>{run.resumeReview=resolve;const timer=setInterval(()=>{try{run.check();}catch(e){clearInterval(timer);reject(e);}},500);run.clearReview=()=>clearInterval(timer);});}finally{run.clearReview?.();delete run.resumeReview;delete run.clearReview;run.waitingFor=null;}
    run.check();await run.event('live_review_resumed',{fileId:file.id});
   }

   async function adapt(file,priorFiles=[]){
    privateState.current=file;
    const initial=evaluateFile(file,privateState.chosen);if(!needsAdaptation(initial.metrics,privateState.chosen,{repeatedReferenceReads:params.scenario==='reference-reuse'?run.referenceReuse.repeatedReferenceReads:0})){await run.event('no_improvement_needed',{fileId:file.id,...publicMetrics(initial.metrics)});return;}
    const message={role:'user',content:JSON.stringify({fileId:file.id,sourceId:file.sourceId,rowCount:file.rowCount,currentConfig:encodeConfig(run.config),diagnostics:diagnostics(initial.results),remainingProposals:2-run.attempts.length})};
    const observed={...diagnostics(initial.results),...(params.scenario==='reference-reuse'?{batchReferenceProfile:run.referenceReuse,trialConstraint:'Known columns/parsing already work. Keep aliases, numbers, units and parsing unchanged. Only safe architecture policies may change; equal quality plus fewer measured reference reads counts as improvement.'}: {})};const freshInput=agentInput(file,privateState.chosen,observed);
    if(!privateState.history)privateState.history=freshInput;else {const fullInput=[...privateState.history,message];if(privateState.chosen.contextMode==='compact_feedback'){const rebuilt=compactContext(fullInput,freshInput,privateState.feedback);privateState.history=rebuilt.input;const change={fileId:file.id,beforeBytes:rebuilt.beforeBytes,afterBytes:rebuilt.afterBytes,savedBytes:rebuilt.beforeBytes-rebuilt.afterBytes,feedbackId:rebuilt.feedbackId,contextMode:privateState.chosen.contextMode};run.contextChanges.push(change);await run.event('context_rebuilt',change);}else privateState.history=fullInput;}
    while(run.attempts.length<2&&run.modelRequests<7){
     const inspected=privateState.inspected.has(file.id)&&privateState.profileRead.has(file.id);const forced=inspected&&(run.modelRequests>=6||run.toolCalls>=11);const available=selectAgentTools(privateState.chosen,{inspected,forced,contextTask:isContext(params.scenario)});privateState.history.push({role:'user',content:JSON.stringify({remainingModelRequests:7-run.modelRequests,remainingToolExecutions:12-run.toolCalls,remainingProposals:2-run.attempts.length,phase:forced?'Submit your best complete proposal now; tool/time budget is reserved for evaluation and transfer.':'Investigate within the available tools.'})});
     const {response,calls}=await modelRequest(run,budget,{input:privateState.history,tools:available,role:'importer',policy:{fileId:file.id,configHash:hash(privateState.chosen),...policies(privateState.chosen)}});
     privateState.history.push(...response.output);
     let proposed=false,accepted=false;
     for(const call of calls){run.check();let output;let args;if(run.toolCalls>=12)throw new Error('TOOL_CALL_LIMIT');run.toolCalls++;
      try {if(!available.some(t=>t.name===call.name))throw new Error('TOOL_NOT_AVAILABLE_IN_PHASE');if(call.name==='propose_harness'&&proposed)throw new Error('ONE_PROPOSAL_PER_RESPONSE');args=JSON.parse(call.arguments);
       if(['inspect_file','get_source_profile','try_transform','inspect_task_context'].includes(call.name)&&args.fileId!==file.id)throw new Error('FILE_ACCESS_DENIED');
       if(call.name==='inspect_file'){if(!Number.isInteger(args.sampleCount)||args.sampleCount<1||args.sampleCount>6)throw new Error('SAMPLE_LIMIT');privateState.inspected.add(file.id);output={fileId:file.id,sourceId:file.sourceId,rawSample:file.raw.split(/\r?\n/).slice(0,args.sampleCount+1).join('\n'),rowCount:file.rowCount};}
       else if(call.name==='get_source_profile'){privateState.profileRead.add(file.id);output={sourceId:file.sourceId,...profiles[file.sourceId]};}
       else if(call.name==='inspect_task_context'){output={tables:file.taskContext||{},contextHash:file.taskContextHash||null,note:'Trusted synthetic task facts; no validation answers and no later-file context.'};}
       else if(call.name==='lookup_catalog'){if(!Array.isArray(args.skus)||args.skus.length>4)throw new Error('SKU_LIMIT');output=args.skus.map(sku=>catalog.find(x=>x.sku===sku)||{sku,error:'UNKNOWN_SKU'});}
       else if(call.name==='lookup_packaging')output=packaging.find(x=>x.sku===args.sku&&x.pack_code===args.packCode)||{error:'UNKNOWN_PACK'};
       else if(call.name==='try_transform'){const c=decodeConfig(args.config);output={...diagnostics(processFile(file,c)),retention:procedureGuard(privateState.chosen,c),architecture:compareArchitecture([file],privateState.chosen,c)};}
       else if(call.name==='propose_harness'){
        if(run.attempts.length>=2)throw new Error('PROPOSAL_LIMIT');
        const number=run.attempts.length+1;const before=structuredClone(privateState.chosen);let candidate,decision;
        try{if(!privateState.inspected.has(file.id)||!privateState.profileRead.has(file.id))throw new Error('INSPECT_AND_PROFILE_REQUIRED');candidate=decodeConfig(args.config);if(privateState.proposalHashes.has(hash(candidate)))throw new Error('DUPLICATE_CANDIDATE');privateState.proposalHashes.add(hash(candidate));decision=gate({before,candidate,file,priorFiles,measurementFiles:params.scenario==='reference-reuse'?privateState.batch.files:null,lockParsing:['reference-reuse','context-challenge','context-deep','context-logistics','context-registry'].includes(params.scenario)});}catch(error){decision={accepted:false,reason:error.message};}
        const attempt={number,fileId:file.id,parentFeedbackId:privateState.feedbackId,reasonSummary:String(args.reason||'').slice(0,600),beforeConfig:before,candidate:candidate||null,...decision};run.attempts.push(attempt);proposed=true;
        if(decision.accepted){privateState.chosen=candidate;run.config=candidate;accepted=true;}
        const feedbackId=`${run.id}:feedback:${number}`;privateState.feedbackId=feedbackId;
        output={feedbackId,proposal:number,accepted:decision.accepted,reason:decision.reason,regressions:decision.regressions,retention:decision.procedureGuard,remainingProposals:2-number,diagnostics:diagnostics(processFile(file,privateState.chosen)),architecture:decision.architecture, instruction:decision.accepted?'Candidate verified; keep this reusable configuration.':'Use actual validation feedback to revise your next proposal. Hidden answers are not available.'};
        privateState.feedback={feedbackId,accepted:decision.accepted,reason:decision.reason,regressions:decision.regressions,retention:decision.procedureGuard,before:decision.before,after:decision.after,regression:decision.regression,architecture:decision.architecture?{beforePolicy:decision.architecture.beforePolicy,afterPolicy:decision.architecture.afterPolicy,readsSaved:decision.architecture.readsSaved,identicalDecisionsAndRecords:decision.architecture.identicalDecisionsAndRecords}:null};
        await run.event('proposal_evaluated',{attempt:number,fileId:file.id,feedbackId,accepted:decision.accepted,reason:decision.reason,before:decision.before,after:decision.after,regression:decision.regression,regressions:decision.regressions});
       }else throw new Error('UNKNOWN_TOOL');
      }catch(error){output={error:error.message};}
      await run.event('tool_call',{role:'importer',tool:call.name,callId:call.call_id,fileId:file.id,arguments:call.name==='propose_harness'||call.name==='try_transform'?{configHash:hash(args?.config||{}),reason:args?.reason}:args,result:output});
      privateState.history.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(output)});
     }
     if(proposed&&accepted)break;
    }
   }
   if(!checkpoint){
   await reviewFailure(fileA,run.baselineMetrics);await adapt(fileA);
   run.transfer=publicMetrics(evaluateFile(fileB,privateState.chosen).metrics);await run.event('transfer_without_new_ai',{fileId:'B',...run.transfer});
   if(privateState.history){privateState.history.push({role:'user',content:JSON.stringify({kind:'observed_transfer_feedback',fileId:'B',diagnostics:diagnostics(processFile(fileB,privateState.chosen)),note:'B was evaluated without new AI. These ordinary diagnostics are now disclosed; it is no longer a hidden test. Preserve previously correct cases.'})});await run.event('transfer_feedback_released',{fileId:'B',note:'Only ordinary validation diagnostics; hidden holdout remains private.'});}
   }
   if(params.durableCheckpoint&&!checkpoint){
    run.remainingMs=Math.max(0,run.deadline-Date.now());
    run.horizon={taskId:run.id,goal:run.prompt,completedFiles:['A','B'],nextFile:'C',checkpointBootId:bootId,resumeCount:0,startingQuality:run.batchBaseline.reduce((a,m)=>a+m.correct,0),total:run.batchBaseline.reduce((a,m)=>a+m.total,0),checkpointQuality:privateState.batch.files.map(f=>evaluateFile(f,privateState.chosen).metrics.correct).reduce((a,n)=>a+n,0),completedQuality:[fileA,fileB].map(f=>publicMetrics(evaluateFile(f,privateState.chosen).metrics)),feedbackId:privateState.feedbackId,historyHash:hash(privateState.history)};
    const saved=makeCheckpoint(run,params,previous,privateState,privateState.batch);run.horizon.checkpointHash=saved.hash;run.horizon.savedAt=saved.savedAt;
    await db.collection('warehouse_checkpoints').insertOne({_id:run.id,state:'READY',checkpoint:saved});
    run.status='SUSPENDED';await run.event('task_checkpoint_saved',{taskId:run.id,...run.horizon,modelRequests:run.modelRequests,toolCalls:run.toolCalls,remainingMs:saved.remainingMs,note:'Safe durable boundary: generation and A/B are complete; no stock commit yet. Resume claims this checkpoint once and starts at C.'});return;
   }
   const fileC=privateState.batch.files[2];run.challenge={before:publicMetrics(evaluateFile(fileC,privateState.chosen).metrics)};await run.event('challenge_baseline',{fileId:'C',...run.challenge.before});if(isContext(params.scenario)&&run.challenge.before.correct<run.challenge.before.total){run.procedureTransfer={before:structuredClone(privateState.chosen.procedure),failedExecution:diagnostics(processFile(fileC,privateState.chosen)),feedbackId:`${run.id}:task:C:execution`};await run.event('procedure_task_failed',{fileId:'C',...run.procedureTransfer});privateState.feedback={...privateState.feedback,taskExecutionFeedback:run.procedureTransfer};}
   await reviewFailure(fileC,run.challenge.before);
   if(run.attempts.length<2&&run.modelRequests<7)await adapt(fileC,[fileA,fileB]);
   if(isContext(params.scenario)){run.forwardTransfer=publicMetrics(evaluateFile(privateState.batch.files[3],privateState.chosen).metrics);await run.event('forward_transfer_without_new_ai',{fileId:'D',...run.forwardTransfer,configHash:hash(privateState.chosen),note:'New rows of the later context task; no D data or oracle were supplied to the agent.'});}
   run.challenge.after=publicMetrics(evaluateFile(fileC,privateState.chosen).metrics);run.transferAfter=publicMetrics(evaluateFile(fileB,privateState.chosen).metrics);
   const existing=await db.collection('warehouse_receipts').find({supplier:{$in:Object.keys(profiles)}},{projection:{key:1,fingerprint:1}}).limit(10000).toArray();const seen=new Map(existing.map(x=>[x.key,x.fingerprint]));
   const accepted=[];run.results=[];const referenceContext=createReferenceContext(run.id);
   for(const file of privateState.batch.files){const results=processFile(file,privateState.chosen,seen,referenceContext);await run.event('reference_context_used',{fileId:file.id,...results.stats});const metrics=assess(results,file.expected);if(metrics.falseAccepts)throw new Error('FINAL_UNSAFE_ACCEPT');if(isContext(params.scenario)&&metrics.correct!==metrics.total)throw new Error('FINAL_CONTEXT_TASK_INCOMPLETE');run.results.push({fileId:file.id,metrics:publicMetrics(metrics),...diagnostics(results),rows:results});accepted.push(...results.filter(x=>x.decision==='ACCEPT').map(x=>x.record));}
   run.architecture=compareArchitecture(privateState.batch.files,run.beforeConfig,privateState.chosen);const control={...privateState.chosen,...policies(run.beforeConfig)};const sumQuality=c=>privateState.batch.files.map(f=>evaluateFile(f,c).metrics).reduce((a,m)=>({correct:a.correct+m.correct,total:a.total+m.total,falseAccepts:a.falseAccepts+m.falseAccepts}),{correct:0,total:0,falseAccepts:0});run.architecture.quality={before:sumQuality(control),after:sumQuality(privateState.chosen)};run.architecture.toolSchemas={beforeBytes:Buffer.byteLength(JSON.stringify(agentTools.filter(t=>run.beforeConfig.toolAccess.includes(t.name)))),afterBytes:Buffer.byteLength(JSON.stringify(agentTools.filter(t=>privateState.chosen.toolAccess.includes(t.name))))};await run.event('architecture_measured',{changed:run.architecture.changed,before:run.architecture.before,after:run.architecture.after,readsSaved:run.architecture.readsSaved,identicalDecisionsAndRecords:run.architecture.identicalDecisionsAndRecords});
   run.check();await run.event('final_validation',{accepted:accepted.length,files:run.results.map(x=>({fileId:x.fileId,metrics:x.metrics,counts:x.counts}))});
   committing=true;const saved=await commit(mongo,db,run,previous,accepted,privateState.chosen);committed=true;committing=false;run.version=saved.version;await run.event('atlas_committed',{version:run.version,documents:accepted.length});
   run.proof=await proof(db,run.id);if(!run.proof?.matched)throw new Error('READBACK_MISMATCH');await run.event('atlas_readback',{matched:true,documents:run.proof.documents,version:run.version});
   if(run.horizon){run.horizon.completedFiles=privateState.batch.files.map(f=>f.id);run.horizon.nextFile=null;run.horizon.finalQuality=run.results.reduce((a,f)=>a+f.metrics.correct,0);run.horizon.goalReached=run.horizon.finalQuality===run.horizon.total;}
   run.status=saved.changed?'COMPLETED':'COMPLETED_NO_IMPROVEMENT';run.completedAt=new Date().toISOString();await run.event('completed',{status:run.status});
  }catch(error){run.error=String(error.message).slice(0,140);run.status=committing||committed?'COMMIT_UNKNOWN':/budget stopped/.test(error.message)?'STOPPED_BUDGET':/cutoff/.test(error.message)?'STOPPED_CUTOFF':error.message==='CANCELLED'?'CANCELLED':'FAILED';try{await run.event('stopped',{status:run.status,error:run.error});}catch{ /* A missing Atlas connection is surfaced, never a fake success. */ }}
  finally{if(checkpoint&&db)try{await db.collection('warehouse_checkpoints').updateOne({_id:run.id,state:'CLAIMED'},{$set:{state:'CONSUMED',finishedAt:new Date().toISOString(),resultStatus:run.status}});}catch{}run.budget=budget.status();if(db)try{await persistRun(db,run);}catch{}setBusy(false);for(const res of listeners.get(run.id)||[])res.end();listeners.delete(run.id);}
 }
 app.post('/api/warehouse/runs',async(req,res)=>{
  if(!mongo)return res.status(503).json({error:'Atlas not configured.'});if(getBusy())return res.status(409).json({error:'An import is already running.'});
  const {prompt,count=30,difficulty='hard',seed=randomUUID(),scenario='standard',pauseOnFailure=false,durableCheckpoint=false}=req.body||{};
  if(typeof durableCheckpoint!=='boolean'||typeof pauseOnFailure!=='boolean'||typeof prompt!=='string'||prompt.length<3||prompt.length>1000||!Number.isInteger(count)||count<20||count>80||!['standard','hard'].includes(difficulty)||typeof seed!=='string'||seed.length>80||!['standard','reference-reuse','context-challenge','context-deep','context-logistics','context-registry'].includes(scenario))return res.status(400).json({error:'Invalid bounded run parameters.'});
  const run={id:randomUUID(),status:'RUNNING',stage:'queued',createdAt:new Date().toISOString(),prompt,count,difficulty,seed,scenario,pauseOnFailure,durableCheckpoint,modelRequests:0,toolCalls:0,events:[],attempts:[],cancelled:false,deadline:Date.now()+600000,budget:budget.status()};
  attach(run);
  runs.set(run.id,run);setBusy(true);res.status(202).json({runId:run.id});void execute(run,{prompt,count,difficulty,seed,scenario,durableCheckpoint});
 });
 app.post('/api/warehouse/runs/:id/resume',async(req,res)=>{
  if(!mongo||getBusy())return res.status(409).json({error:'Import is active or Atlas unavailable.'});setBusy(true);let dispatched=false;
  try{
   await mongo.connect();const db=mongo.db('importforge');const old=await db.collection('warehouse_runs').findOne({_id:req.params.id});const record=await db.collection('warehouse_checkpoints').findOne({_id:req.params.id});
   if(!old||old.status!=='SUSPENDED'||record?.state!=='READY')return res.status(409).json({error:'No unclaimed safe checkpoint. Interrupted external requests are never retried automatically.'});
   const batch=await db.collection('warehouse_batches').findOne({_id:old.id});if(!batch)throw new Error('CHECKPOINT_BATCH_MISSING');delete batch._id;delete batch.createdAt;
   validateCheckpoint(record.checkpoint,old,batch,await prepare(db));
   if(new Date()>new Date('2026-10-12T00:00:00Z'))throw new Error('cutoff reached');
   const claimed=await db.collection('warehouse_checkpoints').updateOne({_id:old.id,state:'READY'},{$set:{state:'CLAIMED',claimedAt:new Date().toISOString(),claimedBootId:bootId}});if(claimed.modifiedCount!==1)throw new Error('CHECKPOINT_ALREADY_CLAIMED');
   const run={...publicRun(old),status:'RUNNING',remainingMs:record.checkpoint.remainingMs,cancelled:false};attach(run);runs.set(run.id,run);dispatched=true;res.status(202).json({runId:run.id,resumed:true});void execute(run,record.checkpoint.params,record.checkpoint);
  }catch(error){res.status(409).json({error:String(error.message).slice(0,140)});}finally{if(!dispatched)setBusy(false);}
 });
 app.get('/api/warehouse/learning-history',async(req,res)=>{
  if(!mongo)return res.status(503).json({error:'Atlas not configured.'});
  try{
   await mongo.connect();const db=mongo.db('importforge');
   const versions=await db.collection('warehouse_harness').find({_id:{$ne:'active'}},{projection:{_id:0,version:1,parentVersion:1,runId:1,configHash:1,createdAt:1}}).sort({version:1}).toArray();
   const active=await db.collection('warehouse_harness').findOne({_id:'active'},{projection:{_id:0,version:1,runId:1,configHash:1}});
   const records=await db.collection('warehouse_runs').find({},{projection:historyProjection}).sort({createdAt:-1,id:-1}).toArray();
   const summaries=records.map(r=>summarizeRun(r,versions));
   res.json({readAt:new Date().toISOString(),mode:'READ_ONLY_ATLAS_HISTORY_NO_AI',active,versions,overview:historyOverview(summaries),runs:summaries,budget:budget.status()});
  }catch{res.status(503).json({error:'Atlas learning history unavailable. No data was changed.'});}
 });
 app.get('/api/warehouse/runs',async(req,res)=>{try{const list=await mongo.db('importforge').collection('warehouse_runs').find({},{projection:{_id:0,id:1,status:1,createdAt:1,version:1}}).sort({createdAt:-1}).limit(10).toArray();res.json(list);}catch{res.status(503).json({error:'Atlas history unavailable.'});}});
 app.get('/api/warehouse/runs/:id',async(req,res)=>{try{const r=await find(req.params.id);if(!r)return res.status(404).end();res.json(r);}catch{res.status(503).json({error:'Atlas unavailable.'});}});
 app.get('/api/warehouse/runs/:id/events',async(req,res)=>{try{const run=await find(req.params.id);if(!run)return res.status(404).end();res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.flushHeaders();const last=Number(req.headers['last-event-id']||req.query.after||0);for(const e of run.events||[])if(e.seq>last)res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);if(terminal.has(run.status))return res.end();if(!listeners.has(run.id))listeners.set(run.id,new Set());listeners.get(run.id).add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(timer);listeners.get(run.id)?.delete(res);});}catch{res.end();}});
 app.get('/api/warehouse/runs/:id/files/:fileId',async(req,res)=>{try{const batch=await mongo.db('importforge').collection('warehouse_batches').findOne({_id:req.params.id});const f=batch?.files.find(x=>x.id===req.params.fileId);if(!f)return res.status(404).end();res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${f.name}"`});res.send(f.raw);}catch{res.status(503).end();}});
 app.post('/api/warehouse/runs/:id/continue',(req,res)=>{const r=runs.get(req.params.id);if(!r||!r.waitingFor||!r.resumeReview||terminal.has(r.status))return res.status(409).json({error:'No active review point.'});const resume=r.resumeReview;delete r.resumeReview;resume();res.json({resumed:true,fileId:r.waitingFor});});
 app.post('/api/warehouse/runs/:id/cancel',(req,res)=>{const r=runs.get(req.params.id);if(!r)return res.status(404).end();if(terminal.has(r.status))return res.status(409).json({error:'Run is terminal.'});r.cancelled=true;res.json({cancellationRequested:true});});
 app.get('/api/warehouse/runs/:id/atlas-proof',async(req,res)=>{try{const p=await proof(mongo.db('importforge'),req.params.id);if(!p)return res.status(404).end();res.json(p);}catch{res.status(503).json({error:'Atlas readback unavailable.'});}});
 app.post('/api/warehouse/runs/:id/reconcile',async(req,res)=>{if(getBusy())return res.status(409).json({error:'Run is active.'});setBusy(true);try{const db=mongo.db('importforge'),p=await proof(db,req.params.id);if(!p?.matched)return res.status(409).json({error:'Readback does not match; no state changed.'});const old=await db.collection('warehouse_runs').findOne({_id:req.params.id});if(!['COMMIT_UNKNOWN','COMMITTED_PENDING_READBACK'].includes(old.status))return res.status(409).json({error:'Run does not need reconciliation.'});const event={seq:(old.events?.length||0)+1,runId:old.id,at:new Date().toISOString(),step:'atlas_readback_reconciled',matched:true,documents:p.documents,mode:'READBACK_ONLY_NO_AI_NO_STOCK_WRITE'};const status=old.version>old.startingVersion?'COMPLETED':'COMPLETED_NO_IMPROVEMENT';await db.collection('warehouse_runs').updateOne({_id:old.id,status:old.status},{$set:{status,stage:event.step,proof:p,completedAt:event.at,reconciled:true},$push:{events:event}});runs.delete(old.id);res.json({status,proof:p,reconciled:true});}catch{res.status(503).json({error:'Reconciliation could not be verified.'});}finally{setBusy(false);}});
 app.post('/api/warehouse/runs/:id/replay',async(req,res)=>{if(getBusy())return res.status(409).json({error:'Run is active.'});setBusy(true);try{const db=mongo.db('importforge');const old=await db.collection('warehouse_runs').findOne({_id:req.params.id});const batch=await db.collection('warehouse_batches').findOne({_id:req.params.id});if(!old?.committedKeys||!batch)return res.status(409).json({error:'Only committed batches may be replayed.'});const before=await db.collection('warehouse_receipts').countDocuments({runId:req.params.id});const stored=await db.collection('warehouse_receipts').find({key:{$in:old.committedKeys}}).toArray();const seen=new Map(stored.map(x=>[x.key,x.fingerprint]));const results=batch.files.map(f=>({fileId:f.id,...diagnostics(processFile(f,old.config,seen))}));const after=await db.collection('warehouse_receipts').countDocuments({runId:req.params.id});const receipt={at:new Date().toISOString(),mode:'READ_ONLY_REPLAY_NO_AI_NO_STOCK_WRITE',before,after,unchanged:before===after,results};await db.collection('warehouse_runs').updateOne({_id:req.params.id},{$push:{replays:receipt}});res.json(receipt);}catch{res.status(503).json({error:'Replay could not be verified.'});}finally{setBusy(false);}});
 return {runs};
}
