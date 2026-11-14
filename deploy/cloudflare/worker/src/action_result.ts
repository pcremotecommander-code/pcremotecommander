export const actionResultTool={name:'get_action_result',description:'Read the result of an action queued for website approval. Use the action_id returned by PCRC. Waits briefly while the user approves. This never executes or retries the action. After approval the website runs it once; do not resend the original write or command. Unknown outcomes require inspection before any new action.',inputSchema:{type:'object',properties:{action_id:{type:'string',pattern:'^[a-f0-9-]{36}$'},wait_seconds:{type:'integer',minimum:0,maximum:15,default:10}},required:['action_id'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};

export async function readActionResult(call:any,stub:{fetch:typeof fetch},accountId:string,sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))) {
  const args=call.params?.arguments??{},seconds=args.wait_seconds??10;
  const error=(text:string)=>({jsonrpc:'2.0',id:call.id,result:{isError:true,content:[{type:'text',text}]}});
  if(typeof args.action_id!=='string'||!/^[a-f0-9-]{36}$/.test(args.action_id)||!Number.isInteger(seconds)||seconds<0||seconds>15||Object.keys(args).some(key=>!['action_id','wait_seconds'].includes(key)))return error('Provide action_id from your approval request and wait_seconds between 0 and 15.');
  for(let attempt=0;attempt<=seconds;attempt++) {
    const response=await stub.fetch('https://internal.invalid/actions/result',{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':accountId},body:JSON.stringify({id:args.action_id})});
    if(!response.ok)return error('This action is unavailable for your account or has expired. Do not repeat a mutation to recover its output; inspect the computer first.');
    const data=await response.json() as {status:string;result?:{content?:unknown[];isError?:boolean}};
    if(['pending','approved','running'].includes(data.status)&&attempt<seconds){await sleep(1000);continue;}
    const {content,...details}=data.result??{};
    return {jsonrpc:'2.0',id:call.id,result:{isError:data.status==='unknown'||data.status==='denied'||data.result?.isError===true,content:content??[{type:'text',text:data.status==='pending'?'Waiting for your approval on the PCRC website. No action has run.':data.status==='denied'?'You denied this action. Nothing was executed.':'Action status: '+data.status+'. Do not resend the mutation.'}],structuredContent:{action_id:args.action_id,status:data.status,...(data.result?{result:details}:{})}}};
  }
  return error('Action status unavailable.');
}
