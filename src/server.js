import express from 'express';
import { MongoClient } from 'mongodb';
import { randomUUID,randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Budget } from './budget.js';
import { baseline,fixtures,parseFixture,apply,evaluate } from './harness.js';
import { propose } from './model.js';
import { firstImprovement } from './evidence.js';
import { mountWarehouse } from './warehouse/workflow.js';
const app=express(),port=Number(process.env.PORT||4317),csrf=randomBytes(32).toString('hex');
const budget=new Budget(fileURLToPath(new URL('../state/api-budget.sqlite',import.meta.url)));
const uri=process.env.MONGODB_URI;
const expectedHost=process.env.MONGODB_EXPECTED_HOST;
let atlasReady=false,mongo=null;
if(uri) try {
 const candidate=new MongoClient(uri,{serverSelectionTimeoutMS:30000,connectTimeoutMS:8000,socketTimeoutMS:15000,maxPoolSize:5,tls:true,tlsAllowInvalidCertificates:false,tlsAllowInvalidHostnames:false});
 const options=candidate.options;
 const actualHosts=options.hosts?.map(x=>x.toString()).sort().join(',');
 atlasReady=Boolean(options.srvHost?options.srvHost===expectedHost:process.env.MONGODB_EXPECTED_HOSTS&&actualHosts===process.env.MONGODB_EXPECTED_HOSTS);
 if(atlasReady) mongo=candidate;
} catch { /* Invalid or unverified connection strings fail closed. */ }
let busy=false;
app.disable('x-powered-by');
app.use((req,res,next)=>{
 if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)) return res.status(403).end();
 res.set({'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});
 next();
});
app.use(express.json({limit:'8kb'}));
app.use((req,res,next)=>{
 if(req.method==='POST'&&(req.headers['x-csrf-token']!==csrf || ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))) return res.status(403).json({error:'Request rejected.'});next();
});
app.get('/api/status',(req,res)=>res.json({csrf,model:'GPT-6 Astra',deployment:'importforge-astra',azureReady:process.env.AZURE_KEYS_ROTATED==='true'&&Boolean(process.env.AZURE_OPENAI_API_KEY),atlasReady,budget:budget.status(),fixtures,localOnly:true}));
app.get('/api/first-improvement',async(req,res)=>{
 if(!mongo) return res.status(503).json({error:'Atlas не настроен. Исторический результат не загружен.'});
 try {
  await mongo.connect();const db=mongo.db('importforge');
  const run=await db.collection('runs').findOne({synthetic:true,version:1,trace:{$elemMatch:{step:'independent_evaluation',decision:'accepted'}}});
  if(!run) return res.json({evidence:null});
  const active=await db.collection('harness').findOne({_id:'active'});
  const records=await db.collection('catalog').find({runId:run._id},{projection:{_id:0}}).toArray();
  res.json({evidence:firstImprovement(run,active,records)});
 } catch {
  res.status(503).json({error:'Не удалось подтвердить историю и правила в Atlas. Данные не сброшены; модель не вызывалась.'});
 }
});
app.post('/api/preview',(req,res)=>{try{res.json({mode:'LOCAL VALIDATOR ONLY — no AI or Atlas calls',rows:apply(parseFixture(req.body.fixture),baseline)});}catch{res.status(400).json({error:'Unknown synthetic fixture.'});}});
app.post('/api/run',async(req,res)=>{
 if(!mongo) return res.status(503).json({error:'Atlas credentials/verified cluster host are not configured. No model call made.'});
 if(busy) return res.status(409).json({error:'An import is already running.'});
 const runId=randomUUID(),trace=[];let session;
 const event=(step,details)=>{trace.push({runId,step,at:new Date().toISOString(),...details});console.log(JSON.stringify({runId,step}));};
 try {
  const rows=parseFixture(req.body.fixture);busy=true;
  event('atlas_connecting');await mongo.connect();const db=mongo.db('importforge');await db.command({ping:1});event('atlas_connected');
  const previous=await db.collection('harness').findOne({_id:'active'});
  const config=previous?.config||baseline;event('harness_loaded',{version:previous?.version||0});
  const before=apply(rows,config);event('immutable_validation',{valid:before.filter(x=>!x.errors.length).length,total:rows.length});
  const candidate=await propose({rows,config,failures:before.map(({row,errors})=>({row,errors})),runId,budget});event('model_tool_call',{tool:'propose_harness',toolCallId:candidate.toolCallId,requestId:candidate.requestId,usage:candidate.usage});
  const beforeScore=evaluate(config),afterScore=evaluate(candidate.config);
  const improved=afterScore>beforeScore;
  const chosen=improved?candidate.config:config;
  const output=apply(rows,chosen),accepted=output.filter(x=>!x.errors.length),rejected=output.filter(x=>x.errors.length);
  const version=(previous?.version||0)+(improved?1:0);
  event('independent_evaluation',{beforeScore,afterScore,total:4,decision:improved?'accepted':'kept_previous'});
  session=mongo.startSession();
  await session.withTransaction(async()=>{
   const current=await db.collection('harness').findOne({_id:'active'},{session});
   if((current?.version||0)!==(previous?.version||0)) throw new Error('Concurrent harness version conflict.');
   if(improved) await db.collection('harness').replaceOne({_id:'active'},{_id:'active',version,config:chosen,runId},{upsert:true,session});
   if(accepted.length) await db.collection('catalog').insertMany(accepted.map(x=>({_id:`${runId}:${x.record.sku}`,runId,synthetic:true,...x.record})),{session});
   await db.collection('runs').insertOne({_id:runId,fixture:req.body.fixture,version,synthetic:true,trace,accepted:accepted.length,rejected},{session});
  });
  const readback=await db.collection('catalog').countDocuments({runId});
  const saved=await db.collection('runs').findOne({_id:runId});
  const persisted=await db.collection('harness').findOne({_id:'active'});
  if(readback!==accepted.length||!saved||(persisted?.version||0)!==version) throw new Error('Atlas readback mismatch.');
  event('atlas_readback',{imported:readback,version});
  await db.collection('runs').updateOne({_id:runId},{$set:{trace}});
  res.json({runId,mode:'LIVE AZURE + ATLAS · SYNTHETIC DATA',version,improved,evaluation:{before:beforeScore,after:afterScore,total:4},accepted,rejected,trace,budget:budget.status()});
 } catch(error) {
  event('failed',{code:error.status||error.code||'execution_error'});console.error(JSON.stringify({runId,name:error.name,code:error.code,message:error.name?.startsWith('Mongo')?error.message.replace(/mongodb[^\s]*/g,'[URI]'):undefined}));
  const safe=error.name==='MongoServerSelectionError'?`Atlas primary недоступна из текущей сети. ${trace.some(x=>x.step==='model_tool_call')?'Вызов модели уже выполнен; проверьте Run ID перед повтором.':'Модель не вызывалась.'} Проверьте доступность primary; не отключайте TLS.`:/budget stopped|cutoff reached|rotation\/configuration/.test(error.message)?error.message:'Live run failed. No automatic retry; inspect the Run ID before repeating.';
  res.status(502).json({error:safe,runId,trace,budget:budget.status()});
 } finally {busy=false;if(session)await session.endSession();}
});
mountWarehouse(app,{mongo,budget,getBusy:()=>busy,setBusy:value=>{busy=value;}});
app.use(express.static(fileURLToPath(new URL('../public/',import.meta.url))));
app.use((error,req,res,next)=>res.status(400).json({error:'Invalid request.'}));
app.listen(port,'127.0.0.1',()=>console.log(`ImportForge local-only: http://127.0.0.1:${port}`));
