import {fields,profiles} from './reference.js';
const identifier=x=>typeof x==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(x)&&!['constructor','prototype','__proto__'].includes(x);
export function checkProcedure(steps){
 if(!Array.isArray(steps)||steps.length>8)throw new Error('PROCEDURE_LIMIT');
 for(const [i,s] of steps.entries()){
  if(s.op==='join'){
   if(Object.keys(s).sort().join()!==['op','table','leftField','rightField','bindings','optional'].sort().join()||![s.table,s.leftField,s.rightField].every(identifier)||typeof s.optional!=='boolean'||!Array.isArray(s.bindings)||!s.bindings.length||s.bindings.length>4)throw new Error('INVALID_JOIN');
   for(const b of s.bindings)if(Object.keys(b).sort().join()!=='from,to'||![b.from,b.to].every(identifier)||fields.includes(b.to))throw new Error('UNSAFE_CONTEXT_BINDING');
  }else if(s.op==='validate'){
   if(Object.keys(s).sort().join()!==['op','sourceField','localeField'].sort().join()||![s.sourceField,s.localeField].every(identifier)||i!==steps.length-1)throw new Error('VALIDATE_MUST_BE_LAST');
  }else throw new Error('UNKNOWN_PROCEDURE_OPERATION');
 }
 if(steps.length&&steps.at(-1).op!=='validate')throw new Error('VALIDATE_REQUIRED');
 return steps;
}
export function bindContext(raw,steps,tables){
 const values={...raw},execution=[];let reads=0;
 for(const s of steps){
  if(s.op==='join'){
   const table=tables[s.table];
   if(!table&&s.optional){execution.push(`skip_absent_table:${s.table}`);continue;}
   execution.push(`join:${s.table}:${s.leftField}=${s.rightField}`);reads++;
   if(!Array.isArray(table))return {error:'CONTEXT_TABLE_UNAVAILABLE',execution,reads};
   const matches=table.filter(r=>Object.hasOwn(values,s.leftField)&&r[s.rightField]===values[s.leftField]);
   if(matches.length!==1)return {error:matches.length?'AMBIGUOUS_CONTEXT_JOIN':'UNRESOLVED_CONTEXT_JOIN',execution,reads};
   for(const b of s.bindings){if(!Object.hasOwn(matches[0],b.from))return {error:'MISSING_CONTEXT_BINDING',execution,reads};values[b.to]=matches[0][b.from];}
  }else{
   execution.push(`bind_source:${s.sourceField}`,`bind_locale:${s.localeField}`);
   const sourceId=values[s.sourceField],locale=values[s.localeField];
   if(!profiles[sourceId]||profiles[sourceId].locale!==locale)return {error:'UNTRUSTED_SOURCE_CONTEXT',execution,reads};
   // A joined trusted supplier row must attest this exact source/locale pair.
   if(!Object.values(tables).some(t=>t.some(r=>r.sourceId===sourceId&&r.locale===locale)))return {error:'UNATTESTED_SOURCE_CONTEXT',execution,reads};
   return {sourceId,profile:{locale},execution,reads};
  }
 }
 return {error:'NO_CONTEXT_PROCEDURE',execution,reads};
}
