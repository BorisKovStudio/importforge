// Public hosting is an explicitly read-only viewer; local operator mode stays local.
export function deploymentPolicy(env,port){
 const readOnly=env.PUBLIC_DEMO_READ_ONLY==='true';
 if(env.WEBSITE_HOSTNAME&&!readOnly)throw new Error('Azure deployment requires explicit read-only mode.');
 if(!readOnly)return {readOnly:false,host:'127.0.0.1',allowedHosts:new Set([`127.0.0.1:${port}`,`localhost:${port}`])};
 const origin=new URL(env.PUBLIC_ORIGIN);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.port)throw new Error('One exact HTTPS public origin is required.');
 if(!/^[a-z0-9.-]+\.azurewebsites\.net$/.test(origin.hostname))throw new Error('Only the authorized Azure App Service origin is supported.');
 return {readOnly:true,host:'0.0.0.0',origin:origin.origin,allowedHosts:new Set([origin.host])};
}
export function readOnlyBudget(value){
 const b=JSON.parse(value);
 for(const key of ['capUsd','chargedAndReservedUsd','conservativeChargedUsd','unresolvedReservedUsd','reservationPerRequestUsd'])if(!Number.isFinite(b[key])||b[key]<0)throw new Error('Invalid recorded budget.');
 if(b.capUsd!==200||b.chargedAndReservedUsd>b.capUsd||Math.abs(b.chargedAndReservedUsd-b.conservativeChargedUsd-b.unresolvedReservedUsd)>0.000001||!Number.isFinite(Date.parse(b.recordedAt)))throw new Error('Invalid recorded budget provenance.');
 return {status:()=>({...b,readOnly:true}),reserve:()=>{throw new Error('Public viewer cannot spend.');},settle:()=>{throw new Error('Public viewer cannot settle spending.');}};
}
export function viewerGuard(policy){
 let windowStart=Date.now(),requests=0;
 return (req,res,next)=>{
  if(!policy.allowedHosts.has(req.headers.host))return res.status(403).json({error:'Host rejected.'});
  if(policy.readOnly){
   if(!['GET','HEAD'].includes(req.method))return res.status(403).json({error:'Read-only public demo. Model calls and mutations are disabled.'});
   if(req.path.startsWith('/api/')){if(Date.now()-windowStart>=60000){windowStart=Date.now();requests=0;}if(++requests>120)return res.status(429).set('Retry-After','60').json({error:'Viewer request limit. Please wait one minute.'});}
  }
  next();
 };
}
