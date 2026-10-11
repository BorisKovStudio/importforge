import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {workflow,displayObject,productNames,summarizeChanges,motionActive} from '../public/ui-data.js';
test('Workflow progress comes from actual events, not time or terminal status',()=>{assert.deepEqual(workflow({status:'COMPLETED',events:[]}),[false,false,false,false,false]);assert.deepEqual(workflow({events:['files_materialized','baseline','proposal_evaluated','final_validation','atlas_readback'].map(step=>({step}))}),[true,true,true,true,true]);assert.deepEqual(workflow({events:[{step:'task_checkpoint_saved'}]}),[false,false,false,false,false]);});
test('English display leaves original records and hashes unchanged',()=>{const source={sku:'WH-003',name:'Вода, бутылка 500 мл',quantity:4,hash:'immutable',aliases:['Артикул из накладной']},before=JSON.stringify(source),view=displayObject(source);assert.equal(JSON.stringify(source),before);assert.equal(view.name,'Water bottle, 500 mL');assert.equal(view.quantity,4);assert.equal(view.hash,'immutable');assert.ok(!/[\u0400-\u04ff]/.test(JSON.stringify(view)));assert.equal(Object.keys(productNames).length,16);});
test('Change explanations are derived from actual configuration differences',()=>{const before={aliases:{sku:['Existing']}},after={aliases:{sku:['Existing','Fresh']}};assert.deepEqual(summarizeChanges(before,after),['Mapped sku: Fresh']);assert.deepEqual(summarizeChanges(after,after),[]);});
test('Primary workspace is English, accessible, native and without legacy fixture clutter',()=>{const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../public/warehouse.css',import.meta.url),'utf8');assert.match(html,/<html lang="en">/);assert.ok(!/[\u0400-\u04ff]/.test(html));assert.ok(!html.includes('/legacy.html'));assert.match(html,/<dialog/);assert.match(html,/aria-label="Completed workflow stages"/);assert.match(css,/prefers-reduced-motion/);});

test('Activity motion runs only during active execution, never pause or recorded outcomes',()=>{
 assert.equal(motionActive({status:'RUNNING'}),true);
 assert.equal(motionActive({status:'RUNNING',waitingFor:'C'}),false);
 for(const status of ['SUSPENDED','COMPLETED','COMPLETED_NO_IMPROVEMENT','FAILED','STOPPED_BUDGET','STOPPED_CUTOFF','CANCELLED','COMMIT_UNKNOWN'])assert.equal(motionActive({status}),false);
 assert.equal(motionActive(null),false);
 const css=readFileSync(new URL('../public/warehouse.css',import.meta.url),'utf8');
 assert.match(css,/\.running \.work-sweep/);assert.match(css,/@keyframes work-scan/);assert.match(css,/@keyframes work-spin/);assert.match(css,/prefers-reduced-motion:reduce/);
});
