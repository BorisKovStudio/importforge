import test from 'node:test';
import assert from 'node:assert/strict';
import {baseline,fullConfig,fields,catalog,packaging,checkConfig} from '../src/warehouse/reference.js';
import {regression,evaluateFile,gate,correct} from '../src/warehouse/evaluator.js';
import {materialize,validatePlan} from '../src/warehouse/generator.js';
import {processFile,normalize} from '../src/warehouse/domain.js';
const format=id=>({id,sourceId:'supplier-ru',delimiter:'semicolon',bom:true,localizedNumbers:true,localizedDates:true,headers:[{field:'sku',source:'Артикул'},{field:'quantity',source:'Количество'},{field:'price_amount',source:'Цена'}],unitLabels:[{canonical:'pcs',label:'шт'},{canonical:'mL',label:'мл'}]});
const plan={title:'Explicit local test fixture, NOT AI generated',formats:[format('A'),{...format('C'),delimiter:'tab'}],templates:catalog.map(p=>({sku:p.sku,packCode:packaging.find(x=>x.sku===p.sku)?.pack_code||'',quantityMin:1,quantityMax:6,priceCents:1260})),faultTypes:['negative_quantity','zero_price','wrong_unit','pack_conflict','missing_unit','missing_expiry','expired','invalid_date','future_receipt','duplicate','foreign_currency','missing_price_basis','unknown_sku','missing_lot','sku_name_conflict'],faultPercent:70};
const adapted=structuredClone(fullConfig);adapted.aliases.sku=['Артикул'];adapted.aliases.quantity=['Количество'];adapted.aliases.price_amount=['Цена'];
test('58 public warehouse cases and 32 independent variants are correct',()=>{const r=regression(fullConfig);assert.equal(r.correct,90);assert.equal(r.total,90);assert.equal(r.falseAccepts,0);});
test('Generated fault oracle agrees with exact valid facts across varied seeds',()=>{for(let seed=0;seed<20;seed++){const b=materialize(plan,{runId:`test-${seed}`,count:80,seed:String(seed)});for(const f of b.files){const x=evaluateFile(f,adapted);assert.equal(x.metrics.correct,80,`${seed}:${f.id}:${x.results.find((r,i)=>!x.metrics.matches[i])?.reason}`);assert.equal(x.metrics.falseAccepts,0);}}});
test('Improvement gate rejects regressions, schema and unit invention',()=>{const file=materialize(plan,{runId:'g',count:30,seed:'1'}).files[0];assert.equal(gate({before:baseline,candidate:adapted,file}).accepted,true);const bad=structuredClone(adapted);bad.decimalComma=false;assert.equal(gate({before:adapted,candidate:bad,file}).accepted,false);assert.throws(()=>checkConfig({...adapted,budget:1000}));assert.throws(()=>checkConfig({...adapted,unitAliases:{...adapted.unitAliases,'kg':'mL'}}));});
test('Replay uses document identity, not Run ID, with conflict quarantine',()=>{const file=materialize(plan,{runId:'i',count:20,seed:'8'}).files[0];const seen=new Map();const first=processFile(file,adapted,seen);const second=processFile(file,adapted,seen);assert.ok(first.some(x=>x.decision==='ACCEPT'));assert.equal(second.filter(x=>x.decision==='ACCEPT').length,0);const raw=first.find(x=>x.decision==='ACCEPT').source;assert.equal(normalize({...raw,quantity:'999'},adapted,{profile:file.profile,namespace:file.sourceId,seen}).reason,'DOCUMENT_CONFLICT');});
test('Both workflow orders execute and context policy performs trusted lookup',()=>{const f=materialize(plan,{runId:'w',count:20,seed:'2'}).files[0];const a=processFile(f,adapted)[0];const b=processFile(f,{...adapted,workflow:'validate_then_lookup'})[0];assert.ok(a.execution.indexOf('resolve_quantity_unit_and_pack')<a.execution.indexOf('parse_quantity'));assert.ok(b.execution.indexOf('parse_quantity')<b.execution.indexOf('resolve_quantity_unit_and_pack'));assert.deepEqual(a.record,b.record);});
test('Fresh oracle catches wrong lot, document identity and exact money',async()=>{const {assess}=await import('../src/warehouse/evaluator.js');const f=materialize(plan,{runId:'oracle',count:20,seed:'5'}).files[0];const result=processFile(f,adapted);const index=result.findIndex(r=>r.decision==='ACCEPT');for(const field of ['lotId','key','lineTotalCents']){const changed=structuredClone(result);changed[index].record[field]=field==='lineTotalCents'?999999:'wrong';assert.ok(assess(changed,f.expected).falseAccepts>0);}});

test('A and C cannot differ only by their file label',()=>{const same=structuredClone(plan);same.formats[1]={...structuredClone(same.formats[0]),id:'C'};assert.throws(()=>validatePlan(same),/GENERATOR_FORMATS_IDENTICAL/);});

test('Architecture changes execute real caching and early price validation, with fixed mappings',async()=>{
 const {compareArchitecture}=await import('../src/warehouse/architecture.js');
 const old={...adapted,workflow:'lookup_before_quantity',contextPolicy:'lookup_all_skus'};
 const candidate={...old,workflow:'validate_numbers_first',contextPolicy:'cached_on_demand',contextMode:'compact_feedback',toolAccess:['inspect_file','get_source_profile','try_transform','propose_harness']};
 const file=materialize(plan,{runId:'architecture',count:80,seed:'18'}).files[0];const r=compareArchitecture([file],old,candidate);
 assert.equal(regression(candidate).correct,90);assert.equal(r.identicalDecisionsAndRecords,true);assert.ok(r.readsSaved>0);assert.ok(r.referenceBytesSaved>0);assert.ok(r.isolated.workflowOnly.totalReads<r.before.totalReads);assert.ok(r.isolated.contextOnly.totalReads<r.before.totalReads);
 assert.deepEqual(old.aliases,candidate.aliases);assert.ok(r.examples.some(x=>x.after.includes('parse_price_before_pack')));
});
test('Tool access is enforced and cannot remove guard tools or invent tools',async()=>{
 const {selectAgentTools}=await import('../src/warehouse/model.js');const config={...adapted,toolAccess:['inspect_file','get_source_profile','propose_harness']};
 assert.deepEqual(selectAgentTools(config,{inspected:true}).map(x=>x.name).sort(),config.toolAccess.slice().sort());
 assert.throws(()=>checkConfig({...adapted,toolAccess:['inspect_file','propose_harness']}),/CONFIG_ACCESS_POLICY/);
 assert.throws(()=>checkConfig({...adapted,toolAccess:[...adapted.toolAccess,'write_database']}),/CONFIG_ACCESS_POLICY/);
});
test('Context compaction retains real feedback and no orphan tool call protocol',async()=>{
 const {compactContext}=await import('../src/warehouse/architecture.js');const feedback={feedbackId:'real-feedback-1',accepted:true};
 const old=[{role:'system',content:'Safety'},{role:'user',content:'Old raw rows'.repeat(1000)}],fresh=[old[0],{role:'user',content:'Current config and diagnostics'}];const compact=compactContext(old,fresh,feedback);
 assert.ok(compact.afterBytes<compact.beforeBytes);assert.match(JSON.stringify(compact.input),/real-feedback-1/);assert.doesNotMatch(JSON.stringify(compact.input),/Old raw rows/);assert.equal(compact.input[0].content,'Safety');
});
test('Legacy warehouse configs gain runtime defaults without mutation',async()=>{
 const {effectiveConfig}=await import('../src/warehouse/reference.js');const old=structuredClone(adapted);delete old.toolAccess;delete old.contextMode;const before=JSON.stringify(old);const loaded=effectiveConfig(old);assert.equal(JSON.stringify(old),before);assert.equal(loaded.contextMode,'full_history');assert.equal(loaded.toolAccess.length,6);checkConfig(loaded);
});

test('Efficiency-only adaptation is accepted without any mapping or quality gain',async()=>{
 const file=materialize(plan,{runId:'efficiency-only',count:80,seed:'18'}).files[0];const before={...adapted,workflow:'validate_then_lookup',contextPolicy:'lookup_all_skus'};const candidate={...before,workflow:'validate_numbers_first',contextPolicy:'cached_on_demand'};const result=gate({before,candidate,file});assert.equal(result.before.correct,result.after.correct);assert.equal(result.accepted,true);assert.ok(result.architecture.readsSaved>0);assert.equal(result.architecture.identicalDecisionsAndRecords,true);assert.deepEqual(candidate.aliases,before.aliases);
});

test('A correct but inefficient pipeline still gets an autonomous optimization attempt',async()=>{const {needsAdaptation}=await import('../src/warehouse/architecture.js');const metrics={correct:30,total:30};assert.equal(needsAdaptation(metrics,adapted),true);const optimized={...adapted,workflow:'validate_numbers_first',contextPolicy:'cached_on_demand',contextMode:'compact_feedback'};assert.equal(needsAdaptation(metrics,optimized),false);assert.equal(needsAdaptation({correct:29,total:30},optimized),true);});

test('Batch reference context beats current per-file cache with identical mapping and quality',async()=>{
 const {compareArchitecture,referenceReuseProfile}=await import('../src/warehouse/architecture.js');
 const batch=materialize(plan,{runId:'batch-efficiency',count:80,seed:'23'});
 const before={...adapted,workflow:'validate_numbers_first',contextPolicy:'cached_on_demand',contextMode:'compact_feedback'};
 const candidate={...before,contextPolicy:'batch_cached_on_demand'};checkConfig(candidate);
 const result=gate({before,candidate,file:batch.files[0],measurementFiles:batch.files,lockParsing:true});
 assert.equal(result.accepted,true);assert.equal(result.reason,'VERIFIED_EFFICIENCY_IMPROVEMENT');assert.equal(result.before.correct,80);assert.equal(result.after.correct,80);
 const measured=compareArchitecture(batch.files,before,candidate);assert.deepEqual(measured.changed,['contextPolicy']);assert.equal(measured.identicalDecisionsAndRecords,true);assert.ok(measured.readsSaved>0);assert.ok(measured.after.crossFileCacheHits>0);assert.ok(measured.after.fileProfiles[1].totalReads<measured.before.fileProfiles[1].totalReads);assert.equal(referenceReuseProfile(batch.files,before).repeatedReferenceReads,measured.readsSaved);
 const changed={...candidate,trim:false};assert.equal(gate({before,candidate:changed,file:batch.files[0],measurementFiles:batch.files,lockParsing:true}).reason,'REFERENCE_TRIAL_RULE_CHANGES_NOT_ALLOWED');
});
test('Batch contexts fail closed across runs and reference revisions',async()=>{
 const {createReferenceContext}=await import('../src/warehouse/domain.js');const a=materialize(plan,{runId:'scope-a',count:20,seed:'1'}),b=materialize(plan,{runId:'scope-b',count:20,seed:'1'});const c={...adapted,contextPolicy:'batch_cached_on_demand'};const context=createReferenceContext('scope-a');
 processFile(a.files[0],c,new Map(),context);assert.throws(()=>processFile(b.files[0],c,new Map(),context),/REFERENCE_CONTEXT_SCOPE_MISMATCH/);assert.throws(()=>processFile(a.files[1],c,new Map(),{...context,referenceHash:'other-revision'}),/REFERENCE_CONTEXT_SCOPE_MISMATCH/);
 const fresh=processFile(b.files[0],c,new Map(),createReferenceContext('scope-b'));assert.ok(fresh.stats.totalReads>0);assert.equal(fresh.stats.crossFileCacheHits,0);assert.ok([...context.catalog.values()].filter(Boolean).every(p=>!Object.hasOwn(p,'baseQuantity')&&!Object.hasOwn(p,'decision')));
});
test('Shared facts never reuse row results, quantities, dates or duplicate decisions',async()=>{
 const {createReferenceContext}=await import('../src/warehouse/domain.js');const {compareArchitecture}=await import('../src/warehouse/architecture.js');const c={...adapted,workflow:'validate_numbers_first',contextPolicy:'batch_cached_on_demand'};
 for(let seed=0;seed<8;seed++){const batch=materialize(plan,{runId:`batch-safety-${seed}`,count:80,seed:String(seed)});const context=createReferenceContext(`batch-safety-${seed}`),seen=new Map();for(const file of batch.files){const results=processFile(file,c,seen,context);assert.equal(results.filter((r,i)=>!correct(r,file.expected[i])).length,0);assert.ok(results.filter(r=>r.decision==='ACCEPT').every(r=>r.record.sourceDocId.includes(file.id)));}const ablation=compareArchitecture(batch.files,{...c,contextPolicy:'cached_on_demand'},c);assert.equal(ablation.identicalDecisionsAndRecords,true);}
 assert.equal(regression(c).correct,90);
});
test('Observed cross-file work triggers optimization without degrading a correct v4',async()=>{
 const {needsAdaptation}=await import('../src/warehouse/architecture.js');const v4={...adapted,workflow:'validate_numbers_first',contextPolicy:'cached_on_demand',contextMode:'compact_feedback'};assert.equal(needsAdaptation({correct:80,total:80},v4),false);assert.equal(needsAdaptation({correct:80,total:80},v4,{repeatedReferenceReads:20}),true);assert.equal(needsAdaptation({correct:80,total:80},{...v4,contextPolicy:'batch_cached_on_demand'},{repeatedReferenceReads:20}),false);
});
