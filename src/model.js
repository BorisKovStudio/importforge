import OpenAI from 'openai';
import { tool,checkConfig } from './harness.js';
export const endpoint=process.env.AZURE_OPENAI_ENDPOINT;
export async function propose({rows,config,failures,runId,budget}) {
 if (!endpoint || process.env.AZURE_KEYS_ROTATED!=='true' || !process.env.AZURE_OPENAI_API_KEY) throw new Error('Azure key rotation/configuration is not verified.');
 const client=new OpenAI({apiKey:process.env.AZURE_OPENAI_API_KEY,baseURL:endpoint,maxRetries:0,timeout:120000});
 const messages=[{role:'system',content:'You maintain a safe declarative CSV import harness. Call propose_harness exactly once with a complete configuration. Map source headers to sku/name/price/quantity, trim whitespace and handle decimal commas if needed. Preserve canonical field fallback. Never change data values, validation requirements or budget. Only the supplied synthetic data is relevant.'},{role:'user',content:JSON.stringify({runId,rows,config,failures})}];
 if (Buffer.byteLength(JSON.stringify({messages,tool}))>24000) throw new Error('Prompt exceeds demo size limit.');
 const requestId=budget.reserve(runId);
 const response=await client.responses.create({model:'importforge-astra',input:messages,tools:[{type:'function',...tool.function}],tool_choice:{type:'function',name:'propose_harness'},parallel_tool_calls:false,max_output_tokens:4096,reasoning:{effort:'high'},store:false});
 const usage=response.usage?{prompt_tokens:response.usage.input_tokens,completion_tokens:response.usage.output_tokens}:undefined;
 budget.settle(requestId,usage);
 const calls=response.output?.filter(x=>x.type==='function_call');
 if (response.status!=='completed' || !calls || calls.length!==1 || calls[0].name!=='propose_harness') throw new Error('Model did not return the required complete tool call.');
 return {config:checkConfig(JSON.parse(calls[0].arguments)),toolCallId:calls[0].call_id,requestId,responseId:response.id,usage};
}
