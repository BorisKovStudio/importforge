import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeContextTask} from '../src/warehouse/context-task.js';
import {fullConfig,catalog,packaging,checkConfig} from '../src/warehouse/reference.js';
import {evaluateFile,gate,regression} from '../src/warehouse/evaluator.js';
import {processFile} from '../src/warehouse/domain.js';
const format=id=>({id,sourceId:id==='A'?'supplier-us':'supplier-ru',delimiter:id==='A'?'comma':'semicolon',bom:id==='C',localizedNumbers:true,localizedDates:true,headers:[{field:'sku',source:'sku'},{field:'quantity',source:'quantity'},{field:'price_amount',source:'price_amount'}],unitLabels:[]});
const plan={title:'Local context interpreter test, NOT AI generated',formats:[format('A'),format('C')],templates:catalog.map(p=>({sku:p.sku,packCode:packaging.find(x=>x.sku===p.sku)?.pack_code||'',quantityMin:1,quantityMax:6,priceCents:1260})),faultTypes:['negative_quantity','zero_price','wrong_unit','pack_conflict','missing_unit','missing_expiry','expired','invalid_date','future_receipt','duplicate','foreign_currency','missing_price_basis','unknown_sku','missing_lot','sku_name_conflict'],faultPercent:65};
const docs={op:'join',table:'documents',leftField:'source_doc_id',rightField:'documentId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:false};
const suppliers={op:'join',table:'suppliers',leftField:'resolvedSource',rightField:'sourceId',bindings:[{from:'locale',to:'resolvedLocale'}],optional:false};
const validate={op:'validate',sourceField:'resolvedSource',localeField:'resolvedLocale'};
const first={...fullConfig,workflow:'validate_numbers_first',contextPolicy:'batch_cached_on_demand',contextMode:'compact_feedback',procedure:[docs,suppliers,validate]};
const revised={...first,procedure:[{...docs,bindings:[...docs.bindings,{from:'channelId',to:'route'}]},{op:'join',table:'channels',leftField:'route',rightField:'channelId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:true},suppliers,validate]};
test('Synthesized programs improve A, transfer B, fail C, and revised program transfers D without mapping changes',()=>{
 for(let seed=0;seed<8;seed++){
  const b=materializeContextTask(plan,{runId:`context-test-${seed}`,count:80,seed:String(seed)}),[a,bb,c,d]=b.files;
  assert.equal(evaluateFile(a,first).metrics.correct,80);assert.equal(evaluateFile(bb,first).metrics.correct,80);assert.ok(evaluateFile(c,first).metrics.correct<80);
  assert.ok(evaluateFile(a,fullConfig).metrics.correct<80);assert.equal(gate({before:fullConfig,candidate:first,file:a,lockParsing:true}).accepted,true);
  const decision=gate({before:first,candidate:revised,file:c,priorFiles:[a,bb],lockParsing:true});assert.equal(decision.accepted,true);
  for(const f of b.files)assert.equal(evaluateFile(f,revised).metrics.correct,80,`${seed}:${f.id}`);
  const seen=new Map();for(const f of b.files){processFile(f,revised,seen);assert.equal(processFile(f,revised,seen).filter(x=>x.decision==='ACCEPT').length,0);}
  assert.ok(processFile(d,revised)[0].execution.some(x=>x.startsWith('join:channels')));
 }
 assert.equal(regression(revised).correct,90);assert.deepEqual(first.aliases,revised.aliases);
});
test('Procedure rejects canonical overwrites, arbitrary operations, bad order and tampered context',()=>{
 assert.throws(()=>checkConfig({...first,procedure:[{...docs,bindings:[{from:'sourceId',to:'quantity'}]},validate]}),/UNSAFE_CONTEXT_BINDING/);
 assert.throws(()=>checkConfig({...first,procedure:[{op:'eval'}]}),/UNKNOWN_PROCEDURE_OPERATION/);
 assert.throws(()=>checkConfig({...first,procedure:[validate,docs]}),/VALIDATE_MUST_BE_LAST/);
 const f=materializeContextTask(plan,{runId:'tamper',count:20,seed:'x'}).files[0];f.taskContext.suppliers[0].locale='ru-RU';assert.throws(()=>processFile(f,first),/TASK_CONTEXT_HASH_MISMATCH/);
});
test('Independent capability guard blocks forgetting a previously mastered context task',async()=>{
 const {procedureGuard}=await import('../src/warehouse/evaluator.js');const kept=procedureGuard(first,revised),forgotten=procedureGuard(revised,{...revised,procedure:[]});assert.ok(kept.protectedTasks>=2);assert.equal(kept.regressions,0);assert.equal(kept.retainedTasks,kept.protectedTasks);assert.equal(forgotten.protectedTasks,4);assert.ok(forgotten.regressions>0);
});
test('New depot/account task fails unchanged saved topology and requires two compatible program extensions',async()=>{
 const {materializeDeepTask}=await import('../src/warehouse/context-task.js');
 const depot={op:'join',table:'depots',leftField:'resolvedSource',rightField:'hubId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:true};
 const account={op:'join',table:'accounts',leftField:'resolvedSource',rightField:'accountId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:true};
 const extended={...revised,procedure:[...revised.procedure.slice(0,2),depot,suppliers,validate]},final={...revised,procedure:[...revised.procedure.slice(0,2),depot,account,suppliers,validate]};
 checkConfig(final);
 for(let seed=0;seed<4;seed++){
  const params={runId:`deep-${seed}`,count:60,seed:String(seed)},old=materializeContextTask(plan,params),deep=materializeDeepTask(plan,params),[a,b,c,d]=deep.files;
  assert.ok(evaluateFile(a,revised).metrics.correct<60);assert.equal(evaluateFile(a,revised).metrics.falseAccepts,0);
  assert.equal(gate({before:revised,candidate:extended,file:a,lockParsing:true}).accepted,true);
  assert.equal(evaluateFile(b,extended).metrics.correct,60);assert.ok(evaluateFile(c,extended).metrics.correct<60);
  assert.equal(gate({before:extended,candidate:final,file:c,priorFiles:[a,b],lockParsing:true}).accepted,true);
  for(const f of [...old.files,...deep.files])assert.equal(evaluateFile(f,final).metrics.correct,60);
  assert.deepEqual(deep.files.map(f=>f.expected),old.files.map(f=>f.expected));assert.deepEqual(deep.files.map(f=>f.raw),old.files.map(f=>f.raw));
  assert.ok(processFile(d,final)[0].execution.some(x=>x.startsWith('join:accounts')));
 }
});
test('Focused new logistics task supports real regression feedback, dry runs, revision and four-file transfer',async()=>{
 const {materializeLogisticsTask}=await import('../src/warehouse/context-task.js');const {selectAgentTools}=await import('../src/warehouse/model.js');
 const config={...revised,toolAccess:revised.toolAccess.filter(x=>x!=='try_transform')};
 assert.ok(!selectAgentTools(config,{inspected:true}).some(t=>t.name==='try_transform'));
 assert.ok(selectAgentTools(config,{inspected:true,contextTask:true}).some(t=>t.name==='try_transform'));
 assert.deepEqual(selectAgentTools(config,{inspected:true,contextTask:true,forced:true}).map(t=>t.name),['propose_harness']);
 const batch=materializeLogisticsTask(plan,{runId:'focused-logistics',count:60,seed:'fresh'});
 const depot={op:'join',table:'depots',leftField:'resolvedSource',rightField:'hubId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:true};
 const compatible={...config,procedure:[...revised.procedure.slice(0,2),depot,suppliers,validate]};
 const unsafe={...compatible,procedure:compatible.procedure.map(s=>s.table==='depots'?{...s,optional:false}:s)};
 const rejected=gate({before:config,candidate:unsafe,file:batch.files[0],lockParsing:true});
 assert.equal(rejected.accepted,false);assert.equal(rejected.after.correct,60);assert.ok(rejected.regressions>0);assert.ok(Object.keys(rejected.procedureGuard.operationalFailures).some(s=>s.includes('CONTEXT_TABLE_UNAVAILABLE')));
 const accepted=gate({before:config,candidate:compatible,file:batch.files[0],lockParsing:true});assert.equal(accepted.accepted,true);
 for(const f of batch.files)assert.equal(evaluateFile(f,compatible).metrics.correct,60);
});

test('Registry task preserves row truth, retains known accounts A/B, and is genuinely unknown to the prior program',async()=>{
 const {materializeDeepTask,materializeRegistryTask}=await import('../src/warehouse/context-task.js');
 const depot={op:'join',table:'depots',leftField:'resolvedSource',rightField:'hubId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:true};
 const account={op:'join',table:'accounts',leftField:'resolvedSource',rightField:'accountId',bindings:[{from:'sourceId',to:'resolvedSource'}],optional:true};
 const saved={...revised,procedure:[...revised.procedure.slice(0,2),depot,account,suppliers,validate]};
 for(let seed=0;seed<4;seed++){
  const params={runId:`registry-${seed}`,count:60,seed:String(seed)};
  const original=materializeDeepTask(plan,params),batch=materializeRegistryTask(plan,params);
  assert.deepEqual(batch.files.map(f=>f.raw),original.files.map(f=>f.raw));
  assert.deepEqual(batch.files.map(f=>f.expected),original.files.map(f=>f.expected));
  for(const file of batch.files){
   const metrics=evaluateFile(file,saved).metrics;
   if(['A','B'].includes(file.id)){assert.equal(metrics.correct,60);assert.equal(file.taskContext.relationships,undefined);}
   else {assert.ok(metrics.correct<60);assert.equal(metrics.falseAccepts,0);assert.ok(processFile(file,saved).some(r=>r.reason==='UNRESOLVED_CONTEXT_JOIN'));}
  }
  assert.notDeepEqual(batch.files[2].taskContext.relationships,batch.files[3].taskContext.relationships);
 }
 // Capacity only: no new task solution is authored here or sent to the model.
 assert.doesNotThrow(()=>checkConfig({...saved,procedure:[...Array.from({length:7},()=>structuredClone(docs)),validate]}));
 assert.throws(()=>checkConfig({...saved,procedure:[...Array.from({length:8},()=>structuredClone(docs)),validate]}),/PROCEDURE_LIMIT/);
});
