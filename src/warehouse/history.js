import {isDeepStrictEqual} from 'node:util';
import {hash} from './reference.js';

export const historyProjection={_id:0,id:1,status:1,createdAt:1,completedAt:1,startingVersion:1,version:1,scenario:1,count:1,modelRequests:1,toolCalls:1,beforeConfig:1,config:1,attempts:1,batchBaseline:1,baselineMetrics:1,transfer:1,forwardTransfer:1,challenge:1,horizon:1,error:1,waitingFor:1,'results.fileId':1,'results.metrics':1,'results.counts':1,'files.id':1,'files.rowCount':1,'files.hash':1,'events.step':1,'events.seq':1,'events.at':1,'events.role':1,'events.fileId':1,'events.feedbackId':1,'events.historyHash':1,'events.checkpointHash':1,'events.oldBootId':1,'events.newBootId':1,'events.taskId':1,'events.version':1,'events.restartVerified':1,'proof.matched':1,'proof.documents':1,'proof.expected':1,'proof.configHash':1,'proof.readAt':1};
export function changeKinds(before,after){
 if(!before||!after)return [];
 return [['aliases','Mapping'],['decimalComma','Parsing'],['dateOrders','Parsing'],['trim','Parsing'],['unitAliases','Parsing'],['procedure','Procedure'],['workflow','Workflow'],['toolAccess','Tools'],['contextPolicy','Context'],['contextMode','Context']].filter(([key])=>!isDeepStrictEqual(key==='toolAccess'&&Array.isArray(before[key])?[...new Set(before[key])].sort():before[key],key==='toolAccess'&&Array.isArray(after[key])?[...new Set(after[key])].sort():after[key])).map(([,label])=>label).filter((x,i,a)=>a.indexOf(x)===i);
}
const sum=rows=>rows?.length?rows.reduce((s,row)=>{const m=row.metrics||row;return {correct:s.correct+(m.correct||0),total:s.total+(m.total||0),falseAccepts:s.falseAccepts+(m.falseAccepts||0)};},{correct:0,total:0,falseAccepts:0}):null;
export function summarizeRun(run,versions=[]){
 const events=run.events||[],attempts=run.attempts||[],finished=run.status?.startsWith('COMPLETED');
 const requests=events.filter(e=>e.step==='model_request');
 const knownRoles=requests.every(e=>['generator','importer'].includes(e.role));
 const importerRequests=!knownRoles?null:requests.length?requests.filter(e=>e.role==='importer').length:run.modelRequests===0?0:null;
 const generatorRequests=!knownRoles?null:requests.length?requests.filter(e=>e.role==='generator').length:run.modelRequests===0?0:null;
 const source=versions.find(v=>v.version===run.startingVersion);
 const loaded=events.find(e=>e.step==='harness_loaded'&&e.version===run.startingVersion);
 const persistedMemory=Boolean(loaded&&source&&source.configHash&&run.beforeConfig&&source.configHash===hash(run.beforeConfig)&&source.runId!==run.id);
 const proposals=attempts.map(a=>({number:a.number,fileId:a.fileId,accepted:Boolean(a.accepted),reason:a.reason||null,parentFeedbackId:a.parentFeedbackId||null,before:a.before||null,after:a.after||null,regression:a.regression||null,regressions:a.regressions??null,changes:changeKinds(a.beforeConfig,a.candidate)}));
 const revised=proposals.filter((a,i)=>{
  if(!i||!a.parentFeedbackId)return false;
  const prev=proposals[i-1],first=events.find(e=>e.step==='proposal_evaluated'&&e.feedbackId===a.parentFeedbackId),second=events.find(e=>e.step==='proposal_evaluated'&&e.fileId===a.fileId&&e.seq>(first?.seq??Infinity));
  return Boolean(first&&second&&(!prev.accepted||events.some(e=>e.step==='procedure_task_failed'&&e.seq>first.seq&&e.seq<second.seq)));
 });
 const accepted=proposals.filter(a=>a.accepted),changes=[...new Set(accepted.flatMap(a=>a.changes))];
 const procedural=accepted.some(a=>a.changes.some(k=>['Procedure','Workflow','Tools','Context'].includes(k)));
 const saved=events.find(e=>e.step==='task_checkpoint_saved'),resumed=events.find(e=>e.step==='task_resumed');
 const restart=Boolean(saved&&resumed&&run.horizon?.restartVerified&&saved.taskId===run.id&&resumed.taskId===run.id&&saved.checkpointHash&&saved.checkpointHash===resumed.checkpointHash&&saved.historyHash&&saved.historyHash===resumed.historyHash&&resumed.oldBootId&&resumed.newBootId&&resumed.oldBootId!==resumed.newBootId&&resumed.restartVerified);
 const transfer=[['B',run.transfer,'transfer_without_new_ai'],['D',run.forwardTransfer,'forward_transfer_without_new_ai']].filter(([,m,step])=>m&&events.some(e=>e.step===step)).map(([fileId,metrics])=>({fileId,...metrics,noNewImporterCall:true}));
 return {id:run.id,status:run.status,createdAt:run.createdAt,completedAt:run.completedAt||null,scenario:run.scenario||'standard',startingVersion:run.startingVersion??null,version:run.version??null,committed:finished&&run.proof?.matched===true,before:sum(run.batchBaseline),after:sum(run.results),receipts:run.proof?.matched?run.proof.documents:null,proof:run.proof||null,modelRequests:run.modelRequests??0,importerRequests,generatorRequests,toolCalls:run.toolCalls??0,proposals,acceptedProposals:accepted.length,rejectedProposals:proposals.length-accepted.length,changes,procedural,feedbackRevision:revised.length>0,proceduralRevision:revised.some(a=>a.accepted&&a.changes.some(k=>['Procedure','Workflow','Tools','Context'].includes(k))),persistedMemory,parentRunId:persistedMemory?source.runId:null,reusedWithoutAdaptation:Boolean(finished&&persistedMemory&&importerRequests===0&&!accepted.length),restartVerified:restart,horizon:run.horizon||null,transfer,files:run.files||[],error:run.error||null,waitingFor:run.waitingFor||null};
}
export function historyOverview(runs){return {runs:runs.length,verified:runs.filter(r=>r.committed).length,procedural:runs.filter(r=>r.procedural&&r.committed).length,feedbackRevisions:runs.filter(r=>r.feedbackRevision).length,memoryReuse:runs.filter(r=>r.reusedWithoutAdaptation).length,restarts:runs.filter(r=>r.restartVerified).length,failures:runs.filter(r=>['FAILED','STOPPED_BUDGET','STOPPED_CUTOFF','CANCELLED','COMMIT_UNKNOWN'].includes(r.status)).length};}
