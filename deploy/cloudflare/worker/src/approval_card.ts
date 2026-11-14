/** Harmless UI probe. Never issues approval credentials or dispatches computer actions. */
export const approvalCardUri='ui://pcrc/approval-card-test-v1.html';
const mimeType='text/html;profile=mcp-app';
export const approvalCardTool={
  name:'test_approval_card',
  description:'Show a harmless in-chat button test using MCP Apps UI. Use when test_approval_dialog says form elicitation is unsupported. Ask whether the card appears. Its buttons never authorize computer access or execute actions.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  outputSchema:{type:'object',properties:{status:{type:'string',enum:['awaiting_ui_test','invalid']},execution_authorized:{type:'boolean',const:false}},required:['status','execution_authorized'],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  _meta:{ui:{resourceUri:approvalCardUri},'openai/outputTemplate':approvalCardUri},
};
export const approvalCardHtml=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:20px;font:15px/1.5 system-ui;color:#effffb;background:#15132b}section{max-width:520px;margin:auto}small{color:#66e9c2}h1{font-size:21px;margin:8px 0}p{color:#d2cfe7}nav{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;padding:10px 16px;border:1px solid #766c9b;border-radius:10px;color:inherit;background:#29233f}button:first-child{background:#65ebc3;color:#102720}button:disabled{opacity:.55}button:focus-visible{outline:3px solid #bbaaff;outline-offset:3px}#status{min-height:3em;font-size:13px}</style></head>
<body><section><small>PCRC · Compatibility check</small><h1>Can you use buttons inside this chat?</h1><p>This is only a UI test. No commands, files, payments or permissions will change.</p><nav aria-label="Harmless test choices"><button id="confirm" disabled>Test confirm button</button><button id="cancel" disabled>Cancel test</button></nav><p id="status" role="status" aria-live="polite">Waiting for the chat host…</p></section>
<script>
const yes=document.getElementById('confirm'),no=document.getElementById('cancel'),status=document.getElementById('status'),version='2026-01-26',prefix='pcrc-test-'+crypto.randomUUID(),pending=new Map();
let sequence=0,ready=false,chosen=false;
function notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*');}
function request(method,params){return new Promise((resolve,reject)=>{const id=prefix+'-'+(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('No host response'));},10000);pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const msg=event.data;if(!msg||msg.jsonrpc!=='2.0')return;const item=pending.get(msg.id);if(!item)return;pending.delete(msg.id);clearTimeout(item.timer);if(msg.error)item.reject(Error('Host rejected UI request'));else item.resolve(msg.result);});
async function choose(decision){if(!ready||chosen)return;chosen=true;yes.disabled=no.disabled=true;status.textContent='Button clicked. Sending the diagnostic result…';try{await request('ui/update-model-context',{content:[{type:'text',text:JSON.stringify({pcrc_ui_test:decision,execution_authorized:false,message:'UI test only; no computer action was approved or executed.'})}]});status.textContent=decision==='confirmed'?'In-chat button test completed. No computer action was authorized.':'Test cancelled. No computer action was authorized.';}catch{status.textContent='The card and button worked, but the host did not acknowledge the result. No computer action was authorized.';}}
yes.onclick=()=>choose('confirmed');no.onclick=()=>choose('cancelled');
request('ui/initialize',{appInfo:{name:'PCRC approval card test',version:'1.0.0'},appCapabilities:{},protocolVersion:version}).then(result=>{if(result?.protocolVersion!==version)throw Error('Unsupported UI protocol');notify('ui/notifications/initialized',{});ready=true;yes.disabled=no.disabled=false;status.textContent='Connected to the chat host. Try either test button.';}).catch(()=>{status.textContent='No compatible chat UI bridge detected. A standalone page cannot prove in-chat support.';});
</script></body></html>`;
export function approvalCardResult(call:any){
  const args=call.params?.arguments??{};
  const valid=args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===0;
  return {jsonrpc:'2.0',id:call.id,result:{...(valid?{}:{isError:true}),content:[{type:'text',text:valid?'Harmless MCP Apps card requested. If it appears, click a test button. Rendering is not yet verified; no computer action is authorized.':'This UI diagnostic accepts no arguments.'}],structuredContent:{status:valid?'awaiting_ui_test':'invalid',execution_authorized:false}}};
}
export function approvalCardResource(id:unknown){return {jsonrpc:'2.0',id,result:{contents:[{uri:approvalCardUri,mimeType,text:approvalCardHtml,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[],frameDomains:[]}}}}]}};}
export function includeApprovalCard(reply:any,method:string,diagnostics=true){
  if(!diagnostics){
    if(Array.isArray(reply?.result?.tools))reply.result.tools=reply.result.tools.filter((tool:any)=>tool?.name!==approvalCardTool.name);
    if(Array.isArray(reply?.result?.resources))reply.result.resources=reply.result.resources.filter((resource:any)=>resource?.uri!==approvalCardUri);
    return reply;
  }
  if(method==='initialize'&&reply?.result?.capabilities){const extensions=reply.result.capabilities.extensions??={};extensions['io.modelcontextprotocol/ui']={mimeTypes:[mimeType]};}
  if(method==='tools/list'&&Array.isArray(reply?.result?.tools)&&!reply.result.tools.some((t:any)=>t.name===approvalCardTool.name))reply.result.tools.push(approvalCardTool);
  if(method==='resources/list'&&Array.isArray(reply?.result?.resources)&&!reply.result.resources.some((r:any)=>r.uri===approvalCardUri))reply.result.resources.push({uri:approvalCardUri,name:'PCRC in-chat button test',mimeType});
  return reply;
}
