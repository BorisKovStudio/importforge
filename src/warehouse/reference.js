import {checkProcedure} from './procedure.js';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
const root=new URL('../../../importforge-warehouse/',import.meta.url);
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const catalog=parse(readFileSync(new URL('catalog.csv',root)),{columns:true,bom:true,skip_empty_lines:true}).map(x=>({...x,expiry_required:x.expiry_required==='True'}));
export const packaging=parse(readFileSync(new URL('packaging.csv',root)),{columns:true,bom:true,skip_empty_lines:true});
export const reference={version:1,catalog,packaging};
export const referenceHash=hash(reference);
export const fields=['source_doc_id','line_no','source_locale','sku','source_name','quantity','uom','pack_code','declared_base_units_per_pack','price_amount','price_basis_qty','price_basis_uom','price_pack_code','currency','lot_id','received_on','expires_on'];
export const profiles={ 'supplier-us':{locale:'en-US'},'supplier-gb':{locale:'en-GB'},'supplier-ru':{locale:'ru-RU'} };
export const approvedUnits={pcs:'pcs',pc:'pcs',pieces:'pcs','шт':'pcs','штуки':'pcs',sheet:'sheet',sheets:'sheet','лист':'sheet',pair:'pair',pairs:'pair',roll:'roll',rolls:'roll',mL:'mL',ml:'mL','мл':'mL',L:'L',l:'L','л':'L',g:'g','г':'g',kg:'kg','кг':'kg',cm:'cm','см':'cm',m:'m','м':'m',box:'box','коробка':'box',case:'case',block:'block','блок':'block',pack:'pack',can:'can',sack:'sack',coil:'coil',bucket:'bucket',jar:'jar'};
export const safeTools=['inspect_file','get_source_profile','lookup_catalog','lookup_packaging','try_transform','propose_harness','inspect_task_context'];
export const mandatoryTools=['inspect_file','get_source_profile','propose_harness'];
export const effectiveConfig=c=>({...structuredClone(c),toolAccess:c.toolAccess||safeTools.filter(x=>x!=='inspect_task_context'),contextMode:c.contextMode||'full_history',procedure:c.procedure||[]});
export const fullConfig={aliases:Object.fromEntries(fields.map(x=>[x,[]])),delimiter:'auto',trim:true,decimalComma:true,grouping:true,dateLocale:true,currencyToken:true,unitAliases:approvedUnits,workflow:'lookup_before_quantity',contextPolicy:'lookup_on_unknown',toolAccess:safeTools.filter(x=>x!=='inspect_task_context'),contextMode:'full_history',procedure:[]};
export const baseline={...structuredClone(fullConfig),delimiter:'comma',decimalComma:false,grouping:false,dateLocale:false,currencyToken:false,trim:false,unitAliases:Object.fromEntries(['pcs','sheet','pair','roll','mL','L','g','kg','cm','m','box','case','block','pack','can','sack','coil','bucket','jar'].map(x=>[x,x])),workflow:'lookup_before_quantity',contextPolicy:'lookup_on_unknown',toolAccess:safeTools.filter(x=>x!=='inspect_task_context'),contextMode:'full_history',procedure:[]};
export function checkConfig(value){
 value={...value,procedure:value?.procedure||[]};checkProcedure(value.procedure);
 if(!value||Object.keys(value).sort().join()!==Object.keys(fullConfig).sort().join())throw new Error('CONFIG_KEYS');
 if(!['auto','comma','semicolon','tab'].includes(value.delimiter)||!['lookup_before_quantity','validate_then_lookup','validate_numbers_first'].includes(value.workflow)||!['lookup_on_unknown','lookup_all_skus','cached_on_demand','batch_cached_on_demand'].includes(value.contextPolicy))throw new Error('CONFIG_POLICY');
 if(!['full_history','compact_feedback'].includes(value.contextMode)||!Array.isArray(value.toolAccess)||value.toolAccess.length>safeTools.length||new Set(value.toolAccess).size!==value.toolAccess.length||value.toolAccess.some(x=>!safeTools.includes(x))||mandatoryTools.some(x=>!value.toolAccess.includes(x)))throw new Error('CONFIG_ACCESS_POLICY');
 for(const key of ['trim','decimalComma','grouping','dateLocale','currencyToken'])if(typeof value[key]!=='boolean')throw new Error('CONFIG_FLAG');
 if(!value.aliases||Object.keys(value.aliases).sort().join()!==fields.slice().sort().join())throw new Error('CONFIG_FIELDS');
 const used=new Set(fields);
 for(const field of fields){if(!Array.isArray(value.aliases[field])||value.aliases[field].length>12)throw new Error('CONFIG_ALIASES');for(const alias of value.aliases[field]){if(typeof alias!=='string'||!alias.length||alias.length>64||['__proto__','constructor','prototype'].includes(alias)||used.has(alias))throw new Error('CONFIG_ALIAS_CONFLICT');used.add(alias);}}
 if(!value.unitAliases||Object.keys(value.unitAliases).length>60)throw new Error('CONFIG_UNITS');
 for(const [a,b] of Object.entries(value.unitAliases))if(approvedUnits[a]!==b)throw new Error('UNAPPROVED_UNIT_ALIAS');
 for(const [a,b] of Object.entries(baseline.unitAliases))if(value.unitAliases[a]!==b)throw new Error('CANONICAL_UNIT_REQUIRED');
 return structuredClone(value);
}
export const loadCorpus=()=>({rows:parse(readFileSync(new URL('inbound.csv',root)),{columns:true,bom:true,skip_empty_lines:true}),expected:parse(readFileSync(new URL('expected-private-to-evaluator.csv',root)),{columns:true,bom:true,skip_empty_lines:true})});
