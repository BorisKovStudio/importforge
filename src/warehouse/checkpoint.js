import {randomUUID} from 'node:crypto';
import {hash,referenceHash} from './reference.js';

export const bootId=randomUUID();
export function makeCheckpoint(run,params,previous,state,batch){
 const data={schema:1,runId:run.id,params,previous,referenceHash,batchHash:hash(batch),remainingMs:Math.max(0,run.deadline-Date.now()),state:{chosen:state.chosen,history:state.history,feedback:state.feedback,feedbackId:state.feedbackId,inspected:[...state.inspected],profileRead:[...state.profileRead],proposalHashes:[...state.proposalHashes]},progress:{completedFiles:['A','B'],nextFile:'C',modelRequests:run.modelRequests,toolCalls:run.toolCalls,proposals:run.attempts.length},savedAt:new Date().toISOString(),bootId};
 return {...data,hash:hash(data)};
}
export function validateCheckpoint(checkpoint,run,batch,active){
 const {hash:expected,...data}=checkpoint;
 if(expected!==hash(data)||data.schema!==1||data.referenceHash!==referenceHash||data.runId!==run.id||data.batchHash!==hash(batch))throw new Error('CHECKPOINT_INTEGRITY_MISMATCH');
 if(run.status!=='SUSPENDED'||data.progress.nextFile!=='C'||data.remainingMs<=0)throw new Error('CHECKPOINT_NOT_RESUMABLE');
 if(data.progress.modelRequests!==run.modelRequests||data.progress.toolCalls!==run.toolCalls||data.progress.proposals!==run.attempts.length||run.modelRequests>7||run.toolCalls>12||run.attempts.length>2)throw new Error('CHECKPOINT_LIMIT_MISMATCH');
 if(hash(data.state.chosen)!==hash(run.config)||data.params.prompt!==run.prompt||data.params.seed!==run.seed||data.params.count!==run.count)throw new Error('CHECKPOINT_GOAL_MISMATCH');
 if(active.version!==data.previous.version||hash(active.config)!==hash(data.previous.config))throw new Error('CHECKPOINT_ACTIVE_VERSION_CONFLICT');
 return data;
}
