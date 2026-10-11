import {parse} from 'csv-parse/sync';
import {materialize} from './generator.js';
import {fields,profiles,hash} from './reference.js';
const serialize=(rows,delimiter,bom)=>`${bom?'\uFEFF':''}${[fields,...rows.map(r=>fields.map(f=>r[f]))].map(row=>row.map(x=>`"${String(x??'').replaceAll('"','""')}"`).join(delimiter)).join('\r\n')}\r\n`;
function iso(raw,locale){if(!/^\d{2}[/.]\d{2}[/.]\d{4}$/.test(raw))return raw;const[a,b,y]=raw.split(/[/.]/);return locale==='en-US'?`${y}-${a}-${b}`:`${y}-${b}-${a}`;}
export function materializeContextTask(plan,params,includeForward=true){
 const batch=materialize(plan,params);
 for(const file of batch.files){
  const format=plan.formats.find(f=>f.id===(file.id==='B'?'A':file.id)),delimiter={comma:',',semicolon:';',tab:'\t'}[format.delimiter];
  const rows=parse(file.raw,{columns:true,bom:true,delimiter}),documents=new Map(),channels=new Map();
  for(const [i,r] of rows.entries()){
   const originalLocale=r.source_locale,docIndex=Math.floor((Number(r.line_no)-1)/4),sourceId=Object.keys(profiles)[docIndex%3],locale=profiles[sourceId].locale;
   r.source_doc_id=`SYN-${params.runId}-${file.id}-D${docIndex}`;r.source_locale='';
   r.price_amount=r.price_amount.replace(',','.');if(locale==='ru-RU')r.price_amount=r.price_amount.replace('.',',');
   for(const field of ['received_on','expires_on']){const canonical=iso(r[field],originalLocale);if(/^\d{4}-\d{2}-\d{2}$/.test(canonical)&&canonical!=='2026-02-30'){const[y,m,d]=canonical.split('-');r[field]=locale==='en-US'?`${m}/${d}/${y}`:`${d}/${m}/${y}`;}else r[field]=canonical;}
   const e=file.expected[i];if(e.decision==='ACCEPT')Object.assign(e.record,{key:`${sourceId}:${r.source_doc_id}:${r.line_no}`,sourceDocId:r.source_doc_id,supplier:sourceId});
   if(file.id==='C'){const channelId=`route-${docIndex%3}`;documents.set(r.source_doc_id,{documentId:r.source_doc_id,sourceId:'',channelId});channels.set(channelId,{channelId,sourceId});}
   else documents.set(r.source_doc_id,{documentId:r.source_doc_id,sourceId,channelId:''});
  }
  file.taskContext={documents:[...documents.values()],...(file.id==='C'?{channels:[...channels.values()]}:{}),suppliers:Object.entries(profiles).map(([sourceId,p])=>({sourceId,locale:p.locale}))};
  file.taskContextHash=hash(file.taskContext);file.raw=serialize(rows,delimiter,format.bom);file.hash=hash(file.raw);file.profile=profiles['supplier-us'];file.sourceId='supplier-us';
 }
 if(includeForward){const forward=materializeContextTask(plan,{...params,seed:`${params.seed}:forward`},false).files[2];forward.id='D';forward.name='D-blind-forward-transfer.csv';forward.raw=forward.raw.replaceAll(`SYN-${params.runId}-C-`,`SYN-${params.runId}-D-`);for(const d of forward.taskContext.documents)d.documentId=d.documentId.replace(`SYN-${params.runId}-C-`,`SYN-${params.runId}-D-`);for(const e of forward.expected)if(e.record){e.record.key=e.record.key.replace(`SYN-${params.runId}-C-`,`SYN-${params.runId}-D-`);e.record.sourceDocId=e.record.sourceDocId.replace(`SYN-${params.runId}-C-`,`SYN-${params.runId}-D-`);}forward.hash=hash(forward.raw);forward.taskContextHash=hash(forward.taskContext);batch.files.push(forward);}
 batch.materializer='validated synthetic context task: mixed supplier documents';return batch;
}

// New task topology only: the saved importer and the oracle remain untouched.
export function materializeDeepTask(plan,params,accountChallenge=true){
 const batch=materializeContextTask(plan,params);
 for(const file of batch.files){
  const context=file.taskContext,oldChannels=new Map((context.channels||[]).map(x=>[x.channelId,x.sourceId]));
  const channels=new Map(),depots=new Map(),accounts=new Map();
  for(const document of context.documents){
   const sourceId=document.sourceId||oldChannels.get(document.channelId),hubId=`hub-${sourceId}`,accountId=`account-${sourceId}`,channelId=`dispatch-${sourceId}`;
   document.sourceId='';document.channelId=channelId;
   channels.set(channelId,{channelId,sourceId:hubId});
   depots.set(hubId,{hubId,sourceId:accountChallenge&&['C','D'].includes(file.id)?accountId:sourceId});
   if(accountChallenge&&['C','D'].includes(file.id))accounts.set(accountId,{accountId,sourceId});
  }
  context.channels=[...channels.values()];context.depots=[...depots.values()];
  if(accounts.size)context.accounts=[...accounts.values()];
  file.taskContextHash=hash(context);
 }
 batch.materializer=accountChallenge?'validated synthetic task: dispatch/depot/account indirection; no solution program supplied':'validated synthetic task: new dispatch/depot indirection, with forward transfers; no solution program supplied';return batch;
}

export const materializeLogisticsTask=(plan,params)=>materializeDeepTask(plan,params,false);

// Task data only. No solution procedure, validator changes, or answer changes.
export function materializeRegistryTask(plan,params){
 const batch=materializeDeepTask(plan,params);
 for(const file of batch.files){
  const context=file.taskContext;
  if(!context.accounts){
   context.accounts=context.depots.map(depot=>{const sourceId=depot.sourceId,accountId=`account-${sourceId}`;depot.sourceId=accountId;return {accountId,sourceId};});
  }
  if(['C','D'].includes(file.id)){
   const relationships=[],organizations=[];
   for(const account of context.accounts){
    const sourceId=account.sourceId;
    const relationshipId=`r-${hash({seed:params.seed,fileId:file.id,sourceId,kind:'relationship'}).slice(0,16)}`;
    const organizationId=`o-${hash({seed:params.seed,fileId:file.id,sourceId,kind:'organization'}).slice(0,16)}`;
    account.sourceId=relationshipId;
    relationships.push({relationshipId,organizationId});
    organizations.push({organizationId,sourceId});
   }
   context.relationships=relationships;context.organizations=organizations;
  }
  file.taskContextHash=hash(context);
 }
 batch.materializer='validated synthetic registry task: opaque independent relationship/entity keys; no solution program supplied';
 return batch;
}
