import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCheckpoint,validateCheckpoint} from '../src/warehouse/checkpoint.js';
import {fullConfig,hash} from '../src/warehouse/reference.js';
import {publicRun} from '../src/warehouse/store.js';
function fixture(){
 const batch={files:[{id:'A'},{id:'B'},{id:'C'}]},params={prompt:'Synthetic durable task',seed:'new',count:60},previous={version:9,config:fullConfig};
 const run={id:'same-task',...params,status:'SUSPENDED',deadline:Date.now()+500000,config:fullConfig,modelRequests:3,toolCalls:4,attempts:[{number:1}]};
 const state={chosen:fullConfig,history:[{role:'user',content:'Actual previous feedback'}],feedback:{feedbackId:'same-task:feedback:1'},feedbackId:'same-task:feedback:1',inspected:new Set(['A']),profileRead:new Set(['A']),proposalHashes:new Set([hash(fullConfig)])};
 return {batch,params,previous,run,checkpoint:makeCheckpoint(run,params,previous,state,batch)};
}
test('Durable checkpoint preserves task, accepted procedure, real feedback and remaining limits',()=>{const f=fixture();const loaded=JSON.parse(JSON.stringify(f.checkpoint));const data=validateCheckpoint(loaded,f.run,f.batch,f.previous);assert.equal(data.progress.nextFile,'C');assert.deepEqual(data.progress.completedFiles,['A','B']);assert.equal(data.progress.modelRequests,3);assert.equal(data.state.feedbackId,'same-task:feedback:1');assert.match(data.state.history[0].content,/Actual previous feedback/);assert.ok(data.remainingMs<=500000);});
test('Changed checkpoint, file, task counters or concurrent harness fail closed',()=>{const f=fixture();assert.throws(()=>validateCheckpoint({...f.checkpoint,remainingMs:9999999},f.run,f.batch,f.previous),/INTEGRITY/);assert.throws(()=>validateCheckpoint(f.checkpoint,f.run,{files:[]},f.previous),/INTEGRITY/);assert.throws(()=>validateCheckpoint(f.checkpoint,{...f.run,modelRequests:0},f.batch,f.previous),/LIMIT/);assert.throws(()=>validateCheckpoint(f.checkpoint,f.run,f.batch,{...f.previous,version:10}),/VERSION_CONFLICT/);assert.throws(()=>validateCheckpoint(f.checkpoint,{...f.run,prompt:'different task'},f.batch,f.previous),/GOAL/);assert.throws(()=>validateCheckpoint(f.checkpoint,{...f.run,status:'COMPLETED'},f.batch,f.previous),/NOT_RESUMABLE/);});
test('Private model history and oracle checkpoint are excluded from the public run',()=>{const f=fixture();const run=publicRun({...f.run,checkpoint:f.checkpoint,privateHistory:f.checkpoint.state.history,expectedRecords:[{private:'oracle'}],horizon:{taskId:f.run.id}});assert.equal(run.checkpoint,undefined);assert.equal(run.privateHistory,undefined);assert.equal(run.expectedRecords,undefined);assert.equal(run.horizon.taskId,'same-task');});
