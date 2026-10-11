import { parse } from 'csv-parse/sync';
export const baseline = { aliases:{sku:'sku',name:'name',price:'price',quantity:'quantity'}, trim:false, decimalComma:false };
export const fixtures = {
  first:'item_code,title,unit_price,stock\n IF-101 ,Amber Notebook,"12,50",8\n IF-102 ,Graphite Pen,"3,20",12\n IF-103 ,Broken Item,-4,2\n IF-104 ,No Stock,7,-1\n',
  next:'item_code,title,unit_price,stock\n IF-201 ,Cobalt Folder,"8,90",5\n IF-202 ,Silver Clip,"2,10",20\n IF-203 ,Bad Price,unknown,4\n'
};
const holdout = [
  { source:{item_code:' HT-301 ',title:'Control One',unit_price:'17,25',stock:'3'}, expected:{sku:'HT-301',name:'Control One',price:17.25,quantity:3} },
  { source:{sku:'HT-302',name:'Control Two',price:'4.50',quantity:'7'}, expected:{sku:'HT-302',name:'Control Two',price:4.5,quantity:7} },
  { source:{item_code:'HT-303',title:'Invalid',unit_price:'-5',stock:'2'}, expected:null },
  { source:{item_code:'HT-304',title:'Invalid',unit_price:'5',stock:'-2'}, expected:null }
];
export function checkConfig(config) {
  if (!config || typeof config.trim!=='boolean' || typeof config.decimalComma!=='boolean') throw new Error('Invalid declarative harness.');
  const keys=['sku','name','price','quantity'];
  if (!config.aliases || Object.keys(config.aliases).sort().join()!=keys.sort().join() || Object.values(config.aliases).some(x=>typeof x!=='string'||['__proto__','constructor','prototype'].includes(x)||!/^[a-zA-Z_]{1,32}$/.test(x))) throw new Error('Invalid field aliases.');
  return { aliases:{...config.aliases},trim:config.trim,decimalComma:config.decimalComma };
}
export function transform(row, config) {
  const result={};
  for (const field of ['sku','name','price','quantity']) {
    let value = row[config.aliases[field]] ?? row[field] ?? '';
    if (typeof value !== 'string') value=String(value);
    if (config.trim) value=value.trim();
    if (field==='price' && config.decimalComma) value=value.replace(',','.');
    result[field]=['price','quantity'].includes(field) && value!=='' ? Number(value) : value;
  }
  return result;
}
export function errors(row) {
  const out=[];
  if (typeof row.sku!=='string'||!/^IF-\d{3}$|^HT-\d{3}$/.test(row.sku)) out.push('sku: expected IF-000');
  if (typeof row.name!=='string'||!row.name.trim()||row.name.length>120) out.push('name: required, max 120');
  if (typeof row.price!=='number'||!Number.isFinite(row.price)||row.price<=0) out.push('price: must be a positive number');
  if (!Number.isInteger(row.quantity)||row.quantity<0) out.push('quantity: must be a nonnegative integer');
  return out;
}
export function evaluate(config) {
  return holdout.reduce((sum,test)=>{
    const actual=transform(test.source,config); const valid=errors(actual).length===0;
    return sum + (test.expected ? Number(valid&&JSON.stringify(actual)===JSON.stringify(test.expected)) : Number(!valid));
  },0);
}
export function parseFixture(name) { if (!Object.hasOwn(fixtures,name)) throw new Error('Only built-in synthetic fixtures are allowed.'); return parse(fixtures[name],{columns:true,skip_empty_lines:true}); }
export function apply(rows,config) { return rows.map((source,index)=>{const record=transform(source,config);return {row:index+2,record,errors:errors(record)};}); }
export const tool = { type:'function', function:{name:'propose_harness',description:'Propose a safe declarative CSV harness. Never modify validators or fabricate data.',strict:true,parameters:{type:'object',additionalProperties:false,properties:{aliases:{type:'object',additionalProperties:false,properties:Object.fromEntries(['sku','name','price','quantity'].map(x=>[x,{type:'string'}])),required:['sku','name','price','quantity']},trim:{type:'boolean'},decimalComma:{type:'boolean'}},required:['aliases','trim','decimalComma']}} };
