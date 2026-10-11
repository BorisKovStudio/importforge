import {reference,referenceHash,baseline,hash} from './reference.js';
export async function prepare(db){
 await db.collection('warehouse_receipts').createIndex({key:1},{unique:true});
 await db.collection('warehouse_reference').updateOne({_id:'v1'},{$setOnInsert:{...reference,hash:referenceHash}},{upsert:true});
 const ref=await db.collection('warehouse_reference').findOne({_id:'v1'});if(ref.hash!==referenceHash||hash({version:ref.version,catalog:ref.catalog,packaging:ref.packaging})!==referenceHash)throw new Error('REFERENCE_HASH_CONFLICT');
 const active=await db.collection('warehouse_harness').findOne({_id:'active'});
 return active||{version:0,config:structuredClone(baseline),configHash:hash(baseline)};
}
export const publicRun=run=>Object.fromEntries(['id','status','stage','createdAt','completedAt','prompt','count','seed','difficulty','modelRequests','toolCalls','events','files','beforeConfig','config','startingVersion','version','attempts','results','baselineMetrics','transfer','transferAfter','challenge','proof','error','budget','generation','architecture','contextChanges','architectureRevision','scenario','referenceReuse','batchBaseline','procedureTransfer','forwardTransfer','waitingFor','pauseOnFailure','durableCheckpoint','horizon','remainingMs'].filter(k=>run[k]!==undefined).map(k=>[k,run[k]]));
export async function persistRun(db,run){await db.collection('warehouse_runs').updateOne({_id:run.id},{$set:publicRun(run)},{upsert:true});}
export async function commit(mongo,db,run,previous,accepted,config){
 const session=mongo.startSession();const changed=hash(config)!==hash(previous.config);const version=previous.version+(changed?1:0);
 const receipts=accepted.map(r=>({...r,runId:run.id,synthetic:true}));
 try {await session.withTransaction(async()=>{
  const current=await db.collection('warehouse_harness').findOne({_id:'active'},{session});if((current?.version||0)!==previous.version)throw new Error('WAREHOUSE_VERSION_CONFLICT');
  if(changed){await db.collection('warehouse_harness').insertOne({_id:`v${version}`,version,config,configHash:hash(config),parentVersion:previous.version,runId:run.id,referenceHash,createdAt:new Date().toISOString()},{session});await db.collection('warehouse_harness').replaceOne({_id:'active'},{_id:'active',version,config,configHash:hash(config),runId:run.id},{upsert:true,session});}
  if(receipts.length)await db.collection('warehouse_receipts').insertMany(structuredClone(receipts),{session});
  await db.collection('warehouse_runs').updateOne({_id:run.id},{$set:{...publicRun(run),status:'COMMITTED_PENDING_READBACK',version,committedKeys:receipts.map(x=>x.key),expectedRecords:receipts}},{upsert:true,session});
 });}finally{await session.endSession();}
 return {version,changed};
}
export async function proof(db,id){
 const run=await db.collection('warehouse_runs').findOne({_id:id});if(!run)return null;
 const actual=await db.collection('warehouse_receipts').find({runId:id},{projection:{_id:0}}).toArray();
 const expected=(run.expectedRecords||[]).map(({_id,...record})=>record);const match=actual.length===expected.length&&expected.every(e=>actual.some(a=>a.key===e.key&&hash(a)===hash(e)));
 const active=await db.collection('warehouse_harness').findOne({_id:'active'});const version=run.version===0?{version:0,config:baseline}:await db.collection('warehouse_harness').findOne({_id:`v${run.version}`});
 const versionMatches=Boolean(version&&hash(version.config)===hash(run.config));
 const totals=Object.fromEntries([...new Set(actual.map(x=>x.sku))].map(sku=>[sku,actual.filter(x=>x.sku===sku).reduce((sum,x)=>sum+x.baseQuantity,0)]));
 return {runId:id,matched:match&&versionMatches&&Array.isArray(run.committedKeys),documents:actual.length,expected:expected.length,version:run.version,activeVersion:active?.version||0,configHash:hash(run.config),totals,records:actual,readAt:new Date().toISOString()};
}
