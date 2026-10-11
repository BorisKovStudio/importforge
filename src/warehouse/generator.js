import { catalog,packaging,fields,approvedUnits,profiles,hash } from './reference.js';
export const faults=['negative_quantity','zero_price','wrong_unit','pack_conflict','missing_unit','missing_expiry','expired','invalid_date','future_receipt','duplicate','foreign_currency','missing_price_basis','unknown_sku','missing_lot','sku_name_conflict'];
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const generationTool={type:'function',name:'create_generation_plan',description:'Create a compact synthetic warehouse test plan. Code will materialize actual CSV files. A and B share a format, C is different. Never supply expected answers.',strict:true,parameters:object({title:{type:'string'},formats:{type:'array',minItems:2,maxItems:2,items:object({id:{type:'string',enum:['A','C']},sourceId:{type:'string',enum:Object.keys(profiles)},delimiter:{type:'string',enum:['comma','semicolon','tab']},bom:{type:'boolean'},localizedNumbers:{type:'boolean'},localizedDates:{type:'boolean'},headers:{type:'array',minItems:3,maxItems:8,items:object({field:{type:'string',enum:fields},source:{type:'string'}})},unitLabels:{type:'array',maxItems:8,items:object({canonical:{type:'string'},label:{type:'string'}})}})},templates:{type:'array',minItems:6,maxItems:16,items:object({sku:{type:'string',enum:catalog.map(x=>x.sku)},packCode:{type:'string'},quantityMin:{type:'integer',minimum:1,maximum:3},quantityMax:{type:'integer',minimum:3,maximum:9},priceCents:{type:'integer',minimum:1,maximum:50000}})},faultTypes:{type:'array',minItems:5,maxItems:12,items:{type:'string',enum:faults}},faultPercent:{type:'integer',minimum:30,maximum:70}})};
export function validatePlan(plan){
 if(!plan||typeof plan.title!=='string'||plan.title.length>160||!Array.isArray(plan.formats)||plan.formats.length!==2||plan.formats.map(x=>x.id).sort().join()!=='A,C')throw new Error('GENERATOR_PLAN_INVALID');
 if(!Array.isArray(plan.templates)||plan.templates.length<6||plan.templates.length>16||!Array.isArray(plan.faultTypes)||plan.faultTypes.length<5||plan.faultTypes.some(x=>!faults.includes(x))||!Number.isInteger(plan.faultPercent)||plan.faultPercent<30||plan.faultPercent>70)throw new Error('GENERATOR_PLAN_INVALID');
 for(const t of plan.templates){if(!catalog.some(x=>x.sku===t.sku)||t.packCode&&!packaging.some(x=>x.sku===t.sku&&x.pack_code===t.packCode)||!Number.isInteger(t.quantityMin)||!Number.isInteger(t.quantityMax)||t.quantityMin<1||t.quantityMax>9||t.quantityMax<t.quantityMin||!Number.isInteger(t.priceCents)||t.priceCents<1||t.priceCents>50000)throw new Error('GENERATOR_TEMPLATE_INVALID');}
 for(const f of plan.formats){if(!profiles[f.sourceId]||!['comma','semicolon','tab'].includes(f.delimiter)||typeof f.bom!=='boolean'||typeof f.localizedNumbers!=='boolean'||typeof f.localizedDates!=='boolean'||!Array.isArray(f.headers)||f.headers.length<3||f.headers.length>8||new Set(f.headers.map(x=>x.field)).size!==f.headers.length)throw new Error('GENERATOR_FORMAT_INVALID');const names=fields.map(field=>f.headers.find(x=>x.field===field)?.source||field);if(new Set(names).size!==fields.length||names.some(x=>typeof x!=='string'||x.length<1||x.length>64||/[\r\n]/.test(x)||['__proto__','constructor','prototype'].includes(x)||/^[=+@-]/.test(x)))throw new Error('GENERATOR_HEADERS_INVALID');if(!Array.isArray(f.unitLabels)||f.unitLabels.length>8||f.unitLabels.some(x=>approvedUnits[x.label]!==x.canonical))throw new Error('GENERATOR_UNITS_INVALID');}
 const formatHash=({id,...format})=>hash(format);
 if(formatHash(plan.formats[0])===formatHash(plan.formats[1]))throw new Error('GENERATOR_FORMATS_IDENTICAL');
 return plan;
}
export function seeded(seed){let state=parseInt(hash(String(seed)).slice(0,8),16);return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
const packKind=code=>Object.entries({CASE:'case',BOX:'box',BLOCK:'block',PACK:'pack',CAN:'can',SACK:'sack',COIL:'coil',BUCKET:'bucket',JAR:'jar'}).find(([k])=>code.startsWith(k))?.[1];
const csv=(rows,headers,delimiter,bom)=>`${bom?'\uFEFF':''}${[headers,...rows].map(row=>row.map(x=>`"${String(x??'').replaceAll('"','""')}"`).join(delimiter)).join('\r\n')}\r\n`;
export function materialize(plan,{runId,count=30,seed='1',asOf='2026-10-11'}){
 validatePlan(plan);if(!Number.isInteger(count)||count<20||count>80)throw new Error('ROW_LIMIT');const random=seeded(seed);const files=[],manifest=[];
 for(const id of ['A','B','C']){
  const format=plan.formats.find(x=>x.id===(id==='B'?'A':id));const profile=profiles[format.sourceId];const rows=[],expected=[];let lastValid=null;
  for(let i=0;i<count;i++){
   const t=plan.templates[(i+Math.floor(random()*plan.templates.length))%plan.templates.length];const p=catalog.find(x=>x.sku===t.sku);const pack=packaging.find(x=>x.sku===t.sku&&x.pack_code===t.packCode);const amount=t.quantityMin+Math.floor(random()*(t.quantityMax-t.quantityMin+1));const multiplier=pack?Number(pack.base_factor):1;const unit=pack?packKind(t.packCode):p.base_unit;
   const receivedOn=`2026-10-${String(1+Math.floor(random()*10)).padStart(2,'0')}`;const expiresOn=`2027-${String(1+Math.floor(random()*9)).padStart(2,'0')}-${String(1+Math.floor(random()*28)).padStart(2,'0')}`;const sourceDocId=`SYN-${runId}-${id}`;const lot=`LOT-${id}-${i+1}`;
   const r=Object.fromEntries(fields.map(x=>[x,'']));Object.assign(r,{source_doc_id:sourceDocId,line_no:String(i+1),source_locale:profile.locale,sku:t.sku,source_name:p.name,quantity:String(amount),uom:unit,pack_code:t.packCode,price_amount:(t.priceCents/100).toFixed(2),price_basis_qty:'1',price_basis_uom:unit,price_pack_code:t.packCode,currency:'USD',lot_id:lot,received_on:receivedOn,expires_on:p.expiry_required?expiresOn:''});
   const key=`${format.sourceId}:${sourceDocId}:${i+1}`;
   // The oracle is assembled from original integer facts, not importer output.
   let e={decision:'ACCEPT',record:{key,sku:t.sku,name:p.name,baseQuantity:amount*multiplier,baseUnit:p.base_unit,priceCentsNumerator:t.priceCents,priceBaseUnitDenominator:multiplier,lineTotalCents:t.priceCents*amount,currency:'USD',lotId:lot,receivedOn,expiresOn:p.expiry_required?expiresOn:null,sourceDocId,lineNo:i+1,supplier:format.sourceId}};
   let fault=null;
   if(i>3&&random()*100<plan.faultPercent){const eligible=plan.faultTypes.filter(x=>x!=='pack_conflict'||pack).filter(x=>!['missing_expiry','expired','missing_lot'].includes(x)||p.expiry_required).filter(x=>x!=='duplicate'||lastValid);fault=eligible[Math.floor(random()*eligible.length)];}
   const setDecision=(decision,reason)=>{e={decision,reason};};
   switch(fault){
    case 'negative_quantity':r.quantity=`-${amount}`;setDecision('REJECT','NONPOSITIVE_QUANTITY');break;
    case 'zero_price':r.price_amount='0.00';setDecision('REJECT','NONPOSITIVE_OR_SUBCENT_PRICE');break;
    case 'wrong_unit':r.uom=['pcs','sheet','pair','roll'].includes(p.base_unit)?(p.base_unit==='roll'?'m':'mL'):(p.base_unit==='g'?'mL':'kg');r.pack_code='';setDecision(['pcs','sheet','pair','roll'].includes(p.base_unit)?'REJECT':'QUARANTINE','INCOMPATIBLE_STOCK_UNIT_OR_DENSITY');break;
    case 'pack_conflict':r.declared_base_units_per_pack=String(multiplier+1);setDecision('REJECT','PACK_SIZE_CONFLICT');break;
    case 'missing_unit':r.uom='';setDecision('QUARANTINE','MISSING_UNIT');break;
    case 'missing_expiry':r.expires_on='';setDecision('QUARANTINE','MISSING_EXPIRY');break;
    case 'expired':r.received_on='2026-09-01';r.expires_on='2026-10-01';setDecision('QUARANTINE','EXPIRED_LOT');break;
    case 'invalid_date':r.received_on='2026-02-30';setDecision('REJECT','INVALID_CALENDAR_DATE');break;
    case 'future_receipt':r.received_on='2026-10-12';setDecision('REJECT','FUTURE_RECEIPT');break;
    case 'foreign_currency':r.currency='EUR';setDecision('QUARANTINE','UNSUPPORTED_CURRENCY');break;
    case 'missing_price_basis':r.price_basis_uom='';setDecision('QUARANTINE','MISSING_PRICE_BASIS');break;
    case 'unknown_sku':r.sku='WH-999';setDecision('QUARANTINE','UNKNOWN_SKU');break;
    case 'missing_lot':r.lot_id='';setDecision('QUARANTINE','MISSING_LOT');break;
    case 'sku_name_conflict':r.source_name='Другой товар';setDecision('QUARANTINE','SKU_NAME_CONFLICT');break;
    case 'duplicate':Object.assign(r,lastValid);setDecision('SKIP_DUPLICATE','IDEMPOTENT_REPLAY');break;
   }
   if(!fault)lastValid={...r};
   if(format.localizedNumbers&&profile.locale==='ru-RU'){r.price_amount=r.price_amount.replace('.',',');r.quantity=r.quantity.replace('.',',');}
   if(format.localizedDates){for(const k of ['received_on','expires_on'])if(/^\d{4}-\d{2}-\d{2}$/.test(r[k])&&r[k]!=='2026-02-30'){const [y,m,d]=r[k].split('-');r[k]=profile.locale==='en-US'?`${m}/${d}/${y}`:`${d}/${m}/${y}`;}}
   for(const k of ['uom','price_basis_uom'])r[k]=format.unitLabels.find(x=>x.canonical===r[k])?.label||r[k];
   rows.push(r);expected.push(e);manifest.push({fileId:id,line:i+1,fault,expected:e});
  }
  const names=fields.map(field=>format.headers.find(x=>x.field===field)?.source||field);const raw=csv(rows.map(r=>fields.map(field=>r[field])),names,{comma:',',semicolon:';',tab:'\t'}[format.delimiter],format.bom);
  files.push({id,contextId:runId,name:`${id}-${id==='A'?'adaptation':id==='B'?'transfer':'challenge'}.csv`,raw,hash:hash(raw),rowCount:count,sourceId:format.sourceId,profile,asOf,expected});
 }
 return {files,manifest,plan,seed,asOf,aiGenerated:true,materializer:'validated deterministic code',planHash:hash(plan)};
}
