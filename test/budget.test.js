import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Budget, upperCost } from '../src/budget.js';
import { baseline,evaluate,apply,parseFixture,checkConfig } from '../src/harness.js';
test('Fail closed across restart, unknown usage and duplicate settlement',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'importforge-')),'budget.sqlite');
 let budget=new Budget(path); const a=budget.reserve('run-a'),b=budget.reserve('run-b');
 for(let i=0;i<3;i++) budget.reserve(`held-${i}`);
 assert.throws(()=>budget.reserve('run-c'),/budget stopped/);
 assert.equal(budget.settle(a,undefined),false);budget.close();budget=new Budget(path);
 assert.equal(budget.status().chargedAndReservedUsd,170);
 assert.throws(()=>budget.reserve('run-c'),/budget stopped/);
 budget.settle(b,{prompt_tokens:1000,completion_tokens:100});
 assert.throws(()=>budget.settle(b,{prompt_tokens:0,completion_tokens:0}),/already settled/);
 assert.equal(budget.status().chargedAndReservedUsd,136.040625); budget.close();
});
test('Maximum supported context plus output fits reservation',()=>assert.ok(upperCost({prompt_tokens:1050000,completion_tokens:4096})<34000000));
test('Independent evaluation accepts useful rules and rejects regression',()=>{
 const config=checkConfig({aliases:{sku:'item_code',name:'title',price:'unit_price',quantity:'stock'},trim:true,decimalComma:true});
 assert.equal(evaluate(baseline),3);assert.equal(evaluate(config),4);
 assert.equal(apply(parseFixture('first'),config).filter(x=>!x.errors.length).length,2);
 assert.equal(apply(parseFixture('next'),config).filter(x=>!x.errors.length).length,2);
 assert.ok(evaluate({...config,decimalComma:false})<evaluate(config));
 assert.throws(()=>checkConfig({...config,aliases:{...config.aliases,sku:'__proto__'}})===null);
});
test('Shared local ledger blocks parallel processes and never exceeds $200',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'importforge-shared-')),'budget.sqlite');
 const a=new Budget(path),b=new Budget(path);const usage={prompt_tokens:1050000,completion_tokens:4096};
 for(let i=0;i<6;i++){const owner=i%2?a:b;owner.settle(owner.reserve(`request-${i}`),usage);}
 assert.throws(()=>a.reserve('over-cap'),/budget stopped/);
 assert.ok(b.status().chargedAndReservedUsd<=200);
 assert.throws(()=>b.reserve('expired',new Date('2026-10-12T00:00:01Z')),/cutoff/);
 a.close();b.close();
});
test('Authorized $100 to $200 migration retains the full old ledger across restart',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'importforge-migrate-')),'budget.sqlite');
 const old=new DatabaseSync(path);
 old.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL CHECK(used>=0 AND used<=100000000));
 INSERT INTO account VALUES(1,85499057);
 CREATE TABLE requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reserved INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
 INSERT INTO requests VALUES('old-charge','old',17499057,1,'2026-10-11'),('unknown-a','old',34000000,0,'2026-10-11'),('unknown-b','old',34000000,0,'2026-10-11');`);
 const rows=old.prepare('SELECT * FROM requests ORDER BY id').all();old.close();
 let budget=new Budget(path);
 assert.deepEqual(budget.db.prepare('SELECT * FROM requests ORDER BY id').all(),rows);
 assert.deepEqual(budget.status(),{capUsd:200,chargedAndReservedUsd:85.499057,conservativeChargedUsd:17.499057,unresolvedReservedUsd:68,reservationPerRequestUsd:34});
 for(let i=0;i<3;i++)budget.reserve(`new-${i}`);
 assert.throws(()=>budget.reserve('over-cap'),/budget stopped/);
 assert.equal(budget.status().chargedAndReservedUsd,187.499057);
 budget.close();budget=new Budget(path);
 assert.equal(budget.status().unresolvedReservedUsd,170);
 assert.throws(()=>budget.reserve('still-over-cap'),/budget stopped/);
 assert.throws(()=>budget.db.prepare('UPDATE account SET used=200000001').run(),/CHECK/);
 budget.close();
});
