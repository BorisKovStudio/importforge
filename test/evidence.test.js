import test from 'node:test';
import assert from 'node:assert/strict';
import { firstImprovement } from '../src/evidence.js';

// Synthetic test data; live evidence is fetched independently from Atlas.
function fixture() {
  const id='test-first';
  const config={aliases:{sku:'item_code',name:'title',price:'unit_price',quantity:'stock'},trim:true,decimalComma:true};
  const trace=[
    {step:'harness_loaded',version:0},
    {step:'immutable_validation',valid:0},
    {step:'model_tool_call',toolCallId:'test-call'},
    {step:'independent_evaluation',beforeScore:3,afterScore:4,total:4,decision:'accepted',at:'2026-10-11T19:30:51Z'},
    {step:'atlas_readback',imported:2,version:1}
  ].map(e=>({...e,runId:id}));
  return {
    run:{_id:id,synthetic:true,version:1,fixture:'first',trace,accepted:2,rejected:[{},{}]},
    active:{version:1,runId:id,config},
    records:[
      {runId:id,synthetic:true,sku:'IF-101',name:'Amber Notebook',price:12.5,quantity:8},
      {runId:id,synthetic:true,sku:'IF-102',name:'Graphite Pen',price:3.2,quantity:12}
    ]
  };
}
test('Historical evidence connects original v0, persisted v1, evaluation and records',()=>{
  const {run,active,records}=fixture(),e=firstImprovement(run,active,records);
  assert.deepEqual(e.evaluation,{before:3,after:4,total:4});
  assert.deepEqual(e.firstFile,{beforeValid:0,afterValid:2,rejected:2});
  assert.equal(e.changes.length,6);assert.equal(e.before.trim,false);assert.equal(e.after.trim,true);
  assert.match(e.source,/reconstructed/);
});
test('Missing history is not presented as a successful demonstration',()=>assert.equal(firstImprovement(null,null,[]),null));
test('A different active version, false score or incomplete readback fails closed',()=>{
  let f=fixture();f.active.runId='other';assert.throws(()=>firstImprovement(f.run,f.active,f.records),/mismatch/);
  f=fixture();f.run.trace.find(e=>e.step==='independent_evaluation').afterScore=3;assert.throws(()=>firstImprovement(f.run,f.active,f.records),/mismatch/);
  f=fixture();f.records.pop();assert.throws(()=>firstImprovement(f.run,f.active,f.records),/mismatch/);
  f=fixture();f.records[0].price=999;assert.throws(()=>firstImprovement(f.run,f.active,f.records),/mismatch/);
});
