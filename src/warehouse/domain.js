import {bindContext} from './procedure.js';
import { parse } from 'csv-parse/sync';
import { catalog,packaging,fields,hash,referenceHash } from './reference.js';
const productMap=new Map(catalog.map(x=>[x.sku,x]));
const packMap=new Map(packaging.map(x=>[`${x.sku}:${x.pack_code}`,x]));
export function decimal(raw,locale,config){
 let s=String(raw??'');if(config.trim)s=s.trim();
 if(config.currencyToken)s=s.replace(/^USD\s+/,'');
 if(config.grouping){if(locale==='ru-RU')s=s.replace(/(?<=\d)[ \u00a0\u202f](?=\d{3}(?:\D|$))/g,'');else if(['en-US','en-GB'].includes(locale)&&/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))s=s.replaceAll(',','');}
 if(config.decimalComma&&locale==='ru-RU')s=s.replace(',','.');
 if(!/^-?\d{1,9}(\.\d{1,6})?$/.test(s))return null;
 const negative=s.startsWith('-');s=s.replace('-','');const [a,b='']=s.split('.');return {n:BigInt(a+b)*(negative?-1n:1n),d:10n**BigInt(b.length)};
}
function date(raw,locale,config){
 let s=String(raw||'');if(config.trim)s=s.trim();
 if(config.dateLocale&&/^\d{2}[/.]\d{2}[/.]\d{4}$/.test(s)&&['en-GB','ru-RU','en-US'].includes(locale)){const [a,b,c]=s.split(/[/.]/);s=locale==='en-US'?`${c}-${a}-${b}`:`${c}-${b}-${a}`;}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return {error:'AMBIGUOUS_OR_UNPARSEABLE_DATE'};
 const d=new Date(`${s}T00:00:00Z`);return !Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s?{error:'INVALID_CALENDAR_DATE'}:{value:s};
}
export function mapRow(raw,config){const out={};for(const key of fields){const source=[key,...config.aliases[key]].find(x=>Object.hasOwn(raw,x));out[key]=source===undefined?'':String(raw[source]??'');if(config.trim)out[key]=out[key].trim();}return out;}
function factor(sku,uom,code,config,packLookup=(s,c)=>packMap.get(`${s}:${c}`)){
 const product=productMap.get(sku);const unit=config.unitAliases[uom];
 if(!unit)return {decision:'QUARANTINE',reason:'UNKNOWN_UNIT'};
 if(code){const p=packLookup(sku,code);if(!p)return {decision:packaging.some(x=>x.pack_code===code)?'REJECT':'QUARANTINE',reason:'UNKNOWN_OR_FOREIGN_PACK'};const kinds={BOX:'box',CASE:'case',BLOCK:'block',PACK:'pack',CAN:'can',SACK:'sack',COIL:'coil',BUCKET:'bucket',JAR:'jar'};const kind=Object.entries(kinds).find(([prefix])=>code.startsWith(prefix))?.[1];if(kind!==unit)return {decision:'REJECT',reason:'PACK_UNIT_CONFLICT'};return {factor:BigInt(p.base_factor),closed:true,pack:p};}
 const units={mL:['volume',1],L:['volume',1000],g:['mass',1],kg:['mass',1000],cm:['length',1],m:['length',100]};
 if(unit===product.base_unit)return {factor:1n};
 if(units[unit]&&units[product.base_unit]&&units[unit][0]===units[product.base_unit][0])return {factor:BigInt(units[unit][1])};
 if(units[unit]&&units[product.base_unit]&&['mass','volume'].includes(units[unit][0])&&['mass','volume'].includes(units[product.base_unit][0]))return {decision:'QUARANTINE',reason:'MISSING_DENSITY'};
 if(['pcs','pair'].includes(unit)&&['pcs','pair'].includes(product.base_unit))return {decision:'QUARANTINE',reason:'UNREGISTERED_PAIR_CONVERSION'};
 return {decision:['pcs','roll','pair','sheet'].includes(product.base_unit)?'REJECT':'QUARANTINE',reason:'INCOMPATIBLE_STOCK_UNIT'};
}
export function normalize(raw,config,{profile,namespace='synthetic',asOf='2026-10-11',seen=new Map(),catalogLookup=sku=>productMap.get(sku),packLookup=(s,c)=>packMap.get(`${s}:${c}`)}={}){
 const execution=[];const r=mapRow(raw,config);const result=(decision,reason,record)=>({decision,reason,source:r,record,execution});
 if(!r.sku)return result('QUARANTINE','UNMAPPED_SKU');
 execution.push('resolve_sku');const product=catalogLookup(r.sku);if(!product)return result('QUARANTINE','UNKNOWN_SKU');
 if(r.source_name!==product.name)return result('QUARANTINE','SKU_NAME_CONFLICT');
 if(!r.source_doc_id||!/^\d{1,6}$/.test(r.line_no)||Number(r.line_no)<1)return result('QUARANTINE','MISSING_DOCUMENT_KEY');
 const locale=profile?.locale??r.source_locale;
 if(profile&&r.source_locale&&r.source_locale!==profile.locale)return result('QUARANTINE','SOURCE_PROFILE_CONFLICT');
 const key=`${namespace}:${r.source_doc_id}:${r.line_no}`;const fingerprint=hash(r);
 if(seen.has(key))return result(seen.get(key)===fingerprint?'SKIP_DUPLICATE':'QUARANTINE',seen.get(key)===fingerprint?'IDEMPOTENT_REPLAY':'DOCUMENT_CONFLICT');
 if(!r.uom)return result('QUARANTINE','MISSING_UNIT');
 let f;if(config.workflow==='lookup_before_quantity'){execution.push('resolve_quantity_unit_and_pack');f=factor(r.sku,r.uom,r.pack_code,config,packLookup);if(f.decision)return result(f.decision,f.reason);}execution.push('parse_quantity');const q=decimal(r.quantity,locale,config);if(!q)return result('QUARANTINE','UNPARSEABLE_NUMBER');
 if(q.n<=0n)return result('REJECT','NONPOSITIVE_QUANTITY');
 let price;
 if(config.workflow==='validate_numbers_first'&&r.currency==='USD'){execution.push('parse_price_before_pack');price=decimal(r.price_amount,locale,config);if(!price)return result('REJECT','INVALID_PRICE');if(price.n<=0n||price.n*100n%price.d!==0n)return result('REJECT','NONPOSITIVE_OR_SUBCENT_PRICE');}
 if(!f){execution.push('resolve_quantity_unit_and_pack');f=factor(r.sku,r.uom,r.pack_code,config,packLookup);}if(f.decision)return result(f.decision,f.reason);
 if(f.closed&&q.n%q.d!==0n)return result('REJECT','FRACTIONAL_CLOSED_PACK');
 if((q.n*f.factor)%q.d!==0n)return result('REJECT','FRACTIONAL_BASE_UNIT');
 const qty=q.n*f.factor/q.d;if(qty>1000000000n)return result('REJECT','QUANTITY_TOO_LARGE');
 if(r.declared_base_units_per_pack){const declared=decimal(r.declared_base_units_per_pack,locale,config);if(!declared||!f.pack||declared.n!==f.factor*declared.d)return result('REJECT','PACK_SIZE_CONFLICT');}
 if(r.currency!=='USD')return result('QUARANTINE','UNSUPPORTED_CURRENCY');
 if(!price){execution.push('parse_price_after_pack');price=decimal(r.price_amount,locale,config);}if(!price)return result('REJECT','INVALID_PRICE');
 if(price.n<=0n||price.n*100n%price.d!==0n)return result('REJECT','NONPOSITIVE_OR_SUBCENT_PRICE');
 if(!r.price_basis_qty||!r.price_basis_uom)return result('QUARANTINE','MISSING_PRICE_BASIS');
 const pq=decimal(r.price_basis_qty,locale,config);if(!pq||pq.n<=0n)return result('REJECT','INVALID_PRICE_BASIS');
 const pf=factor(r.sku,r.price_basis_uom,r.price_pack_code,config,packLookup);if(pf.decision)return result(pf.decision,pf.reason);
 if(pf.closed&&pq.n%pq.d!==0n||pq.n*pf.factor%pq.d!==0n)return result('REJECT','INVALID_PRICE_BASIS');
 const denominator=pq.n*pf.factor/pq.d;if(denominator<=0n)return result('REJECT','INVALID_PRICE_BASIS');
 const received=date(r.received_on,locale,config);if(received.error)return result(received.error==='INVALID_CALENDAR_DATE'?'REJECT':'QUARANTINE',received.error);
 if(received.value>asOf)return result('REJECT','FUTURE_RECEIPT');
 if(product.expiry_required&&!r.lot_id)return result('QUARANTINE','MISSING_LOT');
 if(product.expiry_required&&!r.expires_on)return result('QUARANTINE','MISSING_EXPIRY');
 let expires=null;if(r.expires_on){const exp=date(r.expires_on,locale,config);if(exp.error)return result(exp.error==='INVALID_CALENDAR_DATE'?'REJECT':'QUARANTINE',exp.error);expires=exp.value;if(expires<received.value)return result('REJECT','EXPIRY_BEFORE_RECEIPT');if(expires<asOf)return result('QUARANTINE','EXPIRED_LOT');}
 const numerator=price.n*100n/price.d;
 const total=(numerator*qty*2n+denominator)/(denominator*2n);
 const record={key,fingerprint,sku:r.sku,name:product.name,baseQuantity:Number(qty),baseUnit:product.base_unit,priceCentsNumerator:Number(numerator),priceBaseUnitDenominator:Number(denominator),lineTotalCents:Number(total),currency:'USD',lotId:r.lot_id||null,receivedOn:received.value,expiresOn:expires,sourceDocId:r.source_doc_id,lineNo:Number(r.line_no),supplier:namespace};
 if(!Object.values(record).filter(x=>typeof x==='number').every(Number.isSafeInteger))return result('REJECT','NUMERIC_RANGE');
 seen.set(key,fingerprint);return result('ACCEPT','VALID',record);
}
export function delimiterFor(raw,config){if(config.delimiter!=='auto')return {comma:',',semicolon:';',tab:'\t'}[config.delimiter];const first=raw.replace(/^\uFEFF/,'').split(/\r?\n/)[0];return [',',';','\t'].sort((a,b)=>first.split(b).length-first.split(a).length)[0];}
export const createReferenceContext=scopeId=>({scopeId,referenceHash,catalog:new Map(),packaging:new Map()});
export function processFile(file,config,seen=new Map(),referenceContext=null){
 const batchCache=config.contextPolicy==='batch_cached_on_demand';
 const context=batchCache?(referenceContext||createReferenceContext(file.contextId||'single-file')):null;
 if(context&&(context.referenceHash!==referenceHash||context.scopeId!==(file.contextId||'single-file')))throw new Error('REFERENCE_CONTEXT_SCOPE_MISMATCH');
 let rows;try{rows=parse(file.raw,{columns:true,bom:true,delimiter:delimiterFor(file.raw,config),skip_empty_lines:true,max_record_size:8192});if(rows.length!==file.rowCount)throw new Error('ROW_COUNT');}catch{return Array.from({length:file.rowCount},(_,i)=>({line:i+1,decision:'QUARANTINE',reason:'CSV_PARSE_ERROR',source:{}}));}
 const cache=context?.catalog||new Map(),packCache=context?.packaging||new Map(),lookups=[];
 const inheritedCatalog=new Set(cache.keys()),inheritedPackaging=new Set(packCache.keys());
 const stats={catalogReads:0,packagingReads:0,cacheHits:0,referenceBytes:0,pipelineSteps:0,crossFileCacheHits:0};
 const catalogLookup=sku=>{if(!cache.has(sku)){const value=productMap.get(sku);lookups.push({tool:'catalog',sku});stats.catalogReads++;stats.referenceBytes+=Buffer.byteLength(JSON.stringify(value||null));cache.set(sku,value);}else {stats.cacheHits++;if(inheritedCatalog.has(sku))stats.crossFileCacheHits++;}return cache.get(sku);};
 if(config.contextPolicy==='lookup_all_skus')for(const raw of rows)catalogLookup(mapRow(raw,config).sku);
 const packLookup=(sku,code)=>{const key=`${sku}:${code}`;if(['cached_on_demand','batch_cached_on_demand'].includes(config.contextPolicy)&&packCache.has(key)){stats.cacheHits++;if(inheritedPackaging.has(key))stats.crossFileCacheHits++;return packCache.get(key);}const value=packMap.get(key);lookups.push({tool:'packaging',sku,code});stats.packagingReads++;stats.referenceBytes+=Buffer.byteLength(JSON.stringify(value||null));if(['cached_on_demand','batch_cached_on_demand'].includes(config.contextPolicy))packCache.set(key,value);return value;};
 const results=rows.map((raw,i)=>{const start=lookups.length;let bound=null;if(file.taskContext&&(config.procedure||[]).length){if(hash(file.taskContext)!==file.taskContextHash)throw new Error('TASK_CONTEXT_HASH_MISMATCH');bound=bindContext(mapRow(raw,config),config.procedure,file.taskContext);}const options=bound?{profile:bound.profile,namespace:bound.sourceId}:{profile:file.profile,namespace:file.sourceId};const r={line:i+1,...(bound?.error?{decision:'QUARANTINE',reason:bound.error,source:mapRow(raw,config),execution:bound.execution}:normalize(raw,config,{...options,asOf:file.asOf,seen,catalogLookup,packLookup})),contextLookups:lookups.slice(start)};if(bound&&!bound.error)r.execution=[...bound.execution,...r.execution];stats.pipelineSteps+=r.execution.length;return r;});
 stats.totalReads=stats.catalogReads+stats.packagingReads;stats.contextScope=batchCache?'batch':'file';stats.referenceHash=referenceHash;results.stats=stats;return results;
}
