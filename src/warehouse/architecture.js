import {processFile,createReferenceContext} from './domain.js';
import {effectiveConfig,hash} from './reference.js';
export function needsAdaptation(metrics,config,{repeatedReferenceReads=0}={}){const c=effectiveConfig(config);return metrics.correct!==metrics.total||c.workflow!=='validate_numbers_first'||!['cached_on_demand','batch_cached_on_demand'].includes(c.contextPolicy)||c.contextMode!=='compact_feedback'||repeatedReferenceReads>0&&c.contextPolicy!=='batch_cached_on_demand';}
export const architectureKeys=['workflow','contextPolicy','toolAccess','contextMode','procedure'];
export const policies=config=>Object.fromEntries(architectureKeys.map(k=>[k,effectiveConfig(config)[k]]));
export function measurePipeline(files,config){
 const totals={catalogReads:0,packagingReads:0,cacheHits:0,referenceBytes:0,pipelineSteps:0,totalReads:0,crossFileCacheHits:0};const outputs=[];const rows=[];const fileProfiles=[];const context=createReferenceContext(files[0]?.contextId||'single-file');
 for(const file of files){const results=processFile(file,config,new Map(),context);fileProfiles.push({fileId:file.id,...results.stats});for(const key of Object.keys(totals))totals[key]+=results.stats?.[key]||0;outputs.push(results.map(({decision,record})=>({decision,record})));rows.push(...results.map(r=>({fileId:file.id,line:r.line,decision:r.decision,reason:r.reason,execution:r.execution,referenceReads:r.contextLookups?.length||0})));}
 return {...totals,outputHash:hash(outputs),rows,fileProfiles};
}
export function compareArchitecture(files,before,after){
 const previous=policies(before),next=policies(after);const control={...effectiveConfig(after),...previous};
 const a=measurePipeline(files,control),b=measurePipeline(files,effectiveConfig(after));
 const workflowOnly=measurePipeline(files,{...control,workflow:next.workflow});
 const contextOnly=measurePipeline(files,{...control,contextPolicy:next.contextPolicy});
 const clean=({rows,...value})=>value;
 const examples=a.rows.map((r,i)=>({fileId:r.fileId,line:r.line,decisionBefore:r.decision,decisionAfter:b.rows[i].decision,reason:b.rows[i].reason,before:r.execution,after:b.rows[i].execution,referenceReadsBefore:r.referenceReads,referenceReadsAfter:b.rows[i].referenceReads})).filter(r=>hash(r.before)!==hash(r.after)||r.referenceReadsBefore!==r.referenceReadsAfter).slice(0,5);
 return {method:'SAME_FILES_FIXED_FINAL_MAPPINGS_AND_PARSING_NO_AI_NO_STOCK_WRITE',fileHashes:files.map(f=>({id:f.id,hash:f.hash})),beforePolicy:previous,afterPolicy:next,changed:architectureKeys.filter(k=>hash(previous[k])!==hash(next[k])),before:clean(a),after:clean(b),isolated:{workflowOnly:clean(workflowOnly),contextOnly:clean(contextOnly)},identicalDecisionsAndRecords:a.outputHash===b.outputHash,readsSaved:a.totalReads-b.totalReads,referenceBytesSaved:a.referenceBytes-b.referenceBytes,examples,note:'Counts are instrumented local reference reads and UTF-8 bytes, not Atlas queries, latency or billed savings.'};
}
export function compactContext(fullInput,freshInput,feedback){
 const input=[...freshInput,{role:'user',content:JSON.stringify({kind:'retained_verified_feedback',feedback,note:'Prior raw rows, obsolete candidates and encrypted reasoning were omitted by the selected context policy. Current config, safety instructions and actual feedback remain.'})}];
 return {input,beforeBytes:Buffer.byteLength(JSON.stringify(fullInput)),afterBytes:Buffer.byteLength(JSON.stringify(input)),feedbackId:feedback?.feedbackId||null};
}

export function referenceReuseProfile(files,config){const measured=measurePipeline(files,config);const catalogKeys=new Set(),packKeys=new Set();let repeatedReferenceReads=0;for(const file of files){const rows=processFile(file,config);for(const row of rows)for(const lookup of row.contextLookups||[]){const key=lookup.tool==='catalog'?lookup.sku:`${lookup.sku}:${lookup.code}`;const keys=lookup.tool==='catalog'?catalogKeys:packKeys;if(keys.has(key))repeatedReferenceReads++;else keys.add(key);}}return {fileCount:files.length,currentPolicy:config.contextPolicy,referenceHash:measured.fileProfiles[0]?.referenceHash,totalReads:measured.totalReads,referenceBytes:measured.referenceBytes,repeatedReferenceReads,fileProfiles:measured.fileProfiles,note:'Measured repeated reads of immutable authoritative facts across files; no expected answers or row decisions are disclosed.'};}
