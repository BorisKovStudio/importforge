import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../src/warehouse/reference.js';
import {changeKinds,summarizeRun,historyOverview,historyProjection} from '../src/warehouse/history.js';
const config={aliases:{sku:['sku']},procedure:{steps:[]},workflow:'validate_numbers_first',toolAccess:['inspect_file'],contextPolicy:'cached_on_demand',contextMode:'compact_feedback'};
const base=()=>({id:'new',status:'COMPLETED',startingVersion:1,version:2,beforeConfig:config,config,modelRequests:1,events:[{step:'harness_loaded',version:1},{step:'model_request',role:'generator'}],attempts:[],proof:{matched:true,documents:2,expected:2},batchBaseline:[{correct:1,total:3}],results:[{metrics:{correct:3,total:3,falseAccepts:0}}]});
const versions=[{version:1,runId:'prior',configHash:hash(config)}];
test('History distinguishes mapping-only edits from procedural self-editing',()=>{
 const next={...config,aliases:{sku:['sku','article']}};assert.deepEqual(changeKinds(config,next),['Mapping']);
 const r=base();r.attempts=[{number:1,accepted:true,beforeConfig:config,candidate:next}];assert.equal(summarizeRun(r,versions).procedural,false);
 const policy={...config,toolAccess:['inspect_file','try_transform'],contextMode:'full_history'};assert.deepEqual(changeKinds(config,policy),['Tools','Context']);
});
test('Accepted proposals without failed feedback are not recursive revision',()=>{
 const r=base();r.attempts=[{number:1,fileId:'A',accepted:true},{number:2,fileId:'C',accepted:true,parentFeedbackId:'f1'}];r.events.push({step:'proposal_evaluated',seq:1,fileId:'A',feedbackId:'f1'},{step:'proposal_evaluated',seq:3,fileId:'C',feedbackId:'f2'});assert.equal(summarizeRun(r).feedbackRevision,false);
 r.events.push({step:'procedure_task_failed',seq:2,fileId:'C'});assert.equal(summarizeRun(r).feedbackRevision,true);
 r.attempts[1].candidate={...config,procedure:{steps:[{op:'join'}]}};r.attempts[1].beforeConfig=config;assert.equal(summarizeRun(r).proceduralRevision,true);
});
test('Rejected feedback can lead to revision but does not prove success',()=>{
 const r=base();r.status='FAILED';r.attempts=[{number:1,fileId:'A',accepted:false},{number:2,fileId:'A',accepted:false,parentFeedbackId:'f1'}];r.events.push({step:'proposal_evaluated',seq:1,fileId:'A',feedbackId:'f1'},{step:'proposal_evaluated',seq:2,fileId:'A',feedbackId:'f2'});const s=summarizeRun(r);assert.equal(s.feedbackRevision,true);assert.equal(s.proceduralRevision,false);assert.equal(s.committed,false);
});
test('Persistent reuse needs a matching saved version, load event and zero importer requests',()=>{
 const r=base();r.version=1;r.status='COMPLETED_NO_IMPROVEMENT';const s=summarizeRun(r,versions);assert.equal(s.persistedMemory,true);assert.equal(s.parentRunId,'prior');assert.equal(s.reusedWithoutAdaptation,true);
 r.events.push({step:'model_request',role:'importer'});assert.equal(summarizeRun(r,versions).reusedWithoutAdaptation,false);assert.equal(summarizeRun(r,[{...versions[0],configHash:'wrong'}]).persistedMemory,false);assert.equal(summarizeRun({...r,events:[]},versions).persistedMemory,false);
});
test('Restart requires matching same-task hashes and different boot identities',()=>{
 const r=base();r.horizon={restartVerified:true};r.events.push({step:'task_checkpoint_saved',taskId:'new',checkpointHash:'cp',historyHash:'h'},{step:'task_resumed',taskId:'new',checkpointHash:'cp',historyHash:'h',oldBootId:'old',newBootId:'new',restartVerified:true});assert.equal(summarizeRun(r).restartVerified,true);
 r.events.at(-1).newBootId='old';assert.equal(summarizeRun(r).restartVerified,false);r.events.at(-1).newBootId='new';r.events.at(-1).historyHash='different';assert.equal(summarizeRun(r).restartVerified,false);
});
test('History never invents quality or transfer and retains failed outcomes',()=>{
 const s=summarizeRun({id:'stopped',status:'STOPPED_BUDGET',modelRequests:0});assert.equal(s.before,null);assert.equal(s.after,null);assert.equal(s.receipts,null);assert.deepEqual(s.transfer,[]);assert.equal(s.reusedWithoutAdaptation,false);assert.equal(historyOverview([s]).failures,1);assert.equal(historyProjection.expectedRecords,undefined);assert.equal(historyProjection['results.rows'],undefined);assert.equal(historyProjection['proof.records'],undefined);
});

test('Tool-list ordering is not a capability change and unknown roles cannot prove zero importer calls',()=>{assert.deepEqual(changeKinds({...config,toolAccess:['a','b']},{...config,toolAccess:['b','a']}),[]);const r=base();r.events.push({step:'model_request'});const s=summarizeRun(r,versions);assert.equal(s.importerRequests,null);assert.equal(s.generatorRequests,null);assert.equal(s.reusedWithoutAdaptation,false);});
