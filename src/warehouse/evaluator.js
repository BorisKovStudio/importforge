import {loadCorpus,fullConfig,hash} from './reference.js';
import {isDeepStrictEqual} from 'node:util';
import {compareArchitecture,architectureKeys} from './architecture.js';
import {normalize,processFile} from './domain.js';
import {materializeContextTask} from './context-task.js';
import {catalog,packaging} from './reference.js';
const exactKeys=['key','sku','name','baseQuantity','baseUnit','priceCentsNumerator','priceBaseUnitDenominator','lineTotalCents','currency','lotId','receivedOn','expiresOn','sourceDocId','lineNo','supplier'];
export function correct(actual,expected){return actual.decision===expected.decision&&(expected.decision!=='ACCEPT'||exactKeys.every(k=>!Object.hasOwn(expected.record||{},k)||actual.record?.[k]===expected.record[k]));}
export function assess(results,expected){const matches=results.map((r,i)=>correct(r,expected[i]));return {correct:matches.filter(Boolean).length,total:expected.length,falseAccepts:results.filter((r,i)=>r.decision==='ACCEPT'&&!correct(r,expected[i])).length,matches};}
export const publicMetrics=m=>({correct:m.correct,total:m.total,falseAccepts:m.falseAccepts});
export function evaluateFile(file,config){const results=processFile(file,config);return {results,metrics:assess(results,file.expected)};}
const source=loadCorpus();
const expected=source.expected.map((e,i)=>({decision:e.decision,record:e.decision==='ACCEPT'?{sku:source.rows[i].sku,baseQuantity:Number(e.normalized_quantity),baseUnit:e.base_unit,priceCentsNumerator:Number(e.price_numerator_cents),priceBaseUnitDenominator:Number(e.price_denominator_base_units),currency:'USD',receivedOn:source.rows[i].case_id==='C44'?'2026-10-10':source.rows[i].received_on,expiresOn:source.rows[i].case_id==='C44'?'2026-12-12':source.rows[i].expires_on||null}:undefined}));
const holdout=source.rows.filter((_,i)=>expected[i].decision==='ACCEPT').slice(0,16).flatMap((raw,index)=>{
 const i=source.rows.indexOf(raw),e=expected[i];const n=index%3+2;
 const r={...raw,case_id:`H${index}`,source_doc_id:`HIDDEN-${index}`,line_no:'1',source_locale:'en-US',quantity:String(e.record.baseQuantity*n),uom:e.record.baseUnit,pack_code:'',declared_base_units_per_pack:'',price_amount:(e.record.priceCentsNumerator/100).toFixed(2),price_basis_qty:String(e.record.priceBaseUnitDenominator),price_basis_uom:e.record.baseUnit,price_pack_code:'',received_on:e.record.receivedOn,expires_on:e.record.expiresOn||''};
 return [{raw:r,expected:{decision:'ACCEPT',record:{...e.record,baseQuantity:e.record.baseQuantity*n}}},{raw:{...r,source_doc_id:`HIDDEN-BAD-${index}`,quantity:'-3'},expected:{decision:'REJECT'}}];
});
export function regression(config){let seen=new Map();const publicResults=source.rows.map(r=>normalize(r,config,{seen}));const hiddenResults=holdout.map(x=>normalize(x.raw,config));const a=assess(publicResults,expected),b=assess(hiddenResults,holdout.map(x=>x.expected));return {correct:a.correct+b.correct,total:a.total+b.total,falseAccepts:a.falseAccepts+b.falseAccepts,matches:[...a.matches,...b.matches],publicCorrect:a.correct,publicTotal:a.total,hiddenCorrect:b.correct,hiddenTotal:b.total};}
const contextHoldout=materializeContextTask({title:'Private capability regression, NOT model generated',formats:['A','C'].map(id=>({id,sourceId:id==='A'?'supplier-us':'supplier-ru',delimiter:id==='A'?'comma':'semicolon',bom:id==='C',localizedNumbers:true,localizedDates:true,headers:['sku','quantity','price_amount'].map(field=>({field,source:field})),unitLabels:[]})),templates:catalog.map(p=>({sku:p.sku,packCode:packaging.find(x=>x.sku===p.sku)?.pack_code||'',quantityMin:1,quantityMax:8,priceCents:1907})),faultTypes:['negative_quantity','zero_price','wrong_unit','missing_unit','future_receipt','duplicate','unknown_sku','missing_lot'],faultPercent:50},{runId:'private-capability-regression',count:20,seed:'capability-retention-v1'}).files;
export function procedureGuard(before,candidate){
 const old=contextHoldout.map(f=>evaluateFile(f,before).metrics),trials=contextHoldout.map(f=>evaluateFile(f,candidate)),next=trials.map(t=>t.metrics);
 const protectedFiles=old.map((m,i)=>m.correct===m.total?i:-1).filter(i=>i>=0);
 const operationalFailures={};for(const i of protectedFiles)for(const [j,r]of trials[i].results.entries())if(old[i].matches[j]&&!next[i].matches[j]){const key=`${r.reason||r.decision} @ ${r.execution?.at(-1)||'validator'}`;operationalFailures[key]=(operationalFailures[key]||0)+1;}
 return {operationalFailures,protectedTasks:protectedFiles.length,retainedTasks:protectedFiles.filter(i=>next[i].correct===next[i].total).length,regressions:protectedFiles.reduce((n,i)=>n+old[i].matches.filter((v,j)=>v&&!next[i].matches[j]).length,0)};
}
export function gate({before,candidate,file,priorFiles=[],measurementFiles=null,lockParsing=false}){
 const old=evaluateFile(file,before),next=evaluateFile(file,candidate);const a=regression(before),b=regression(candidate);
 const retained=procedureGuard(before,candidate);
 const regressions=retained.regressions+old.metrics.matches.filter((v,i)=>v&&!next.metrics.matches[i]).length+a.matches.filter((v,i)=>v&&!b.matches[i]).length+priorFiles.reduce((sum,f)=>{const p=evaluateFile(f,before),q=evaluateFile(f,candidate);return sum+p.metrics.matches.filter((v,i)=>v&&!q.metrics.matches[i]).length;},0);
 const architecture=compareArchitecture(measurementFiles||[file,...priorFiles],before,candidate);
 const efficient=architecture.identicalDecisionsAndRecords&&architecture.readsSaved>0;
 const improves=next.metrics.correct>old.metrics.correct||next.metrics.correct===old.metrics.correct&&efficient;const unchangedRules=!lockParsing||isDeepStrictEqual(Object.fromEntries(Object.entries(before).filter(([k])=>!architectureKeys.includes(k))),Object.fromEntries(Object.entries(candidate).filter(([k])=>!architectureKeys.includes(k))));
 const safe=unchangedRules&&b.falseAccepts===0&&next.metrics.falseAccepts===0&&regressions===0&&(next.metrics.correct>old.metrics.correct||architecture.identicalDecisionsAndRecords)&&priorFiles.every(f=>evaluateFile(f,candidate).metrics.falseAccepts===0);
 return {accepted:improves&&safe,reason:!unchangedRules?'REFERENCE_TRIAL_RULE_CHANGES_NOT_ALLOWED':!safe?'REGRESSION_OR_UNSAFE_ACCEPT':!improves?'NO_MEASURABLE_IMPROVEMENT':next.metrics.correct===old.metrics.correct?'VERIFIED_EFFICIENCY_IMPROVEMENT':'VERIFIED_IMPROVEMENT',before:publicMetrics(old.metrics),after:publicMetrics(next.metrics),regression:publicMetrics(b),procedureGuard:retained,regressions,candidateHash:hash(candidate),architecture};
}
