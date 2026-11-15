import {CONTROL_CATALOG_READ_TOOLS} from './relay_protocol.ts';
/** Strict, independently testable policy around the OAuth library and origin. */
import {authenticatedGitHubId,authenticatedAccountId,permittedAccount,validBetaIds} from './account_identity.ts';
import {approvalPreview,includeApprovalPreview} from './approval_preview.ts';
import {readActionResult} from './action_result.ts';
import {approvalCardUri,approvalCardResult,approvalCardResource,includeApprovalCard} from './approval_card.ts';
import {resultPreviewUri,resultPreviewResource,includeResultPreview} from './result_preview.ts';
import {includeTextResult} from '../../../mcp-task-server/src/text-result.ts';
import {inspectPublicOutput,PrivacyError} from '../../../mcp-task-server/src/privacy-guard.ts';
import privacyRules from '../../../../src/jan_mcp_commander/privacy-rules.json' with {type:'json'};
import {hasReadScope,hasControlScope} from './oauth_scopes.ts';
import {authenticatedMcpRateLimit} from './public_rate_limit.ts';
import {verifiedRelayStatus} from './relay_status.ts';
export interface Settings {
  JAN_PUBLIC_ORIGIN: string;
  JAN_ORIGIN: string;
  JAN_PROXY_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_ID: string;
  PCRC_OWNER_GITHUB_ID?: string;
  JAN_AUTO_ORIGIN?: string;
  JAN_RELAY_ENABLED?: string;
  JAN_PAIRING_ENABLED?: string;
  JAN_MULTI_USER_ENABLED?: string;
  JAN_BETA_GITHUB_IDS?: string;
  JAN_SITE_ROLE?: 'public'|'owner';
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_ID?: string;
  PADDLE_SANDBOX_API_KEY?: string;
  PADDLE_LIVE_API_KEY?: string;
  PADDLE_ENVIRONMENT?: 'sandbox'|'production';
  PADDLE_LIVE_ENABLED?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  PCRC_EMAIL_AUTH_ENABLED?: string;
  PCRC_PUBLIC_SITE_ORIGIN?: string;
  OAUTH_KV?: KVNamespace;
  DEVICES?: DurableObjectNamespace;
  BILLING_SERVICE?: Fetcher;
}
export const MAX_BODY = 262144;
export const MAX_RESPONSE = 1048576;
function privacyToolError(id:unknown,error:unknown):any {
  const code=error instanceof PrivacyError?error.code:'SENSITIVE_CONTENT_BLOCKED';
  const summary=error instanceof PrivacyError?error.message:privacyRules.error;
  return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:summary}],structuredContent:{ok:false,summary,error_code:code,data:{error_code:code}}}};
}
function privateToolResult(reply:any):any {
  try {
    const result=reply?.result,values:unknown[]=[reply?.error??{}];
    if(result&&typeof result==='object'&&!Array.isArray(result)){
      // Wire wrappers must not consume the payload's unchanged depth budget.
      const {content,structuredContent,...metadata}=result;
      values.push(metadata,structuredContent);
      if(Array.isArray(content)){
        if(content.length>10000)throw new PrivacyError('OUTPUT_LIMIT_EXCEEDED','Output exceeded privacy inspection limits. Request a smaller result.');
        for(const part of content){
          if(part&&typeof part==='object'&&part.type==='text'&&typeof part.text==='string'){
            const {text,...attributes}=part;values.push(attributes,text);
          }else values.push(part);
        }
      }else if(content!==undefined)values.push({content});
    }else values.push(result??{});
    inspectPublicOutput(values,privacyRules);
    if(result)includeTextResult(result);
    return reply;
  }catch(error){return privacyToolError(reply?.id,error);}
}
function clientPayload(payload:string,method:string,nativeHost:boolean,relayCall?:unknown):Uint8Array {
  const reply=JSON.parse(payload);
  if(relayCall)verifiedRelayStatus(reply,relayCall);
  const result=['initialize','tools/list','resources/list'].includes(method)
    ?includeResultPreview(includeApprovalCard(includeApprovalPreview(reply,!nativeHost),method,!nativeHost),method)
    :method==='tools/call'||method==='resources/read'?privateToolResult(reply):reply;
  const bytes=new TextEncoder().encode(JSON.stringify(result));
  if(bytes.byteLength>MAX_RESPONSE)throw new Error('Client result exceeds response limit');
  return bytes;
}
const READ_TOOLS=new Set(['jan_inspect_document_pdf','jan_preview_document_workflow','jan_get_document_workflow','jan_preview_spreadsheet','jan_inspect_office','jan_inspect_media','jan_transcribe_audio','jan_read_pdf','jan_task_state','jan_workflow_state','jan_status','jan_list_files','jan_read_text','jan_diagnostic','jan_run_profile','jan_file_info','jan_find_files','jan_search_text','jan_skills','jan_route_skill','jan_skill_guide','jan_feedback_status']);
const READ_TASK_TOOLS=new Set(['inspect_document_pdf','preview_document_workflow','get_document_workflow','get_privacy_policy','inspect_office_document','preview_spreadsheet_edit','preview_file_edit','inspect_media','transcribe_audio','read_pdf','list_tasks','list_workflows','inspect_workflow','test_approval_card','get_action_result','test_approval_dialog','read_multiple_files','get_more_search_results','list_searches','stop_search','get_config','who_am_i','list_processes','list_applications','get_connection_status','get_capabilities','get_recent_activity','list_workspace_entries','search_workspace','inspect_file','read_file_excerpt','compare_files','run_diagnostic','suggest_workflow','list_skill_packs','diagnose_connection']);
const READ_METHODS=new Set(['initialize','notifications/initialized','ping','logging/setLevel','tools/list','resources/list','resources/templates/list','prompts/list','prompts/get','completion/complete']);
export function controlRequired(body: Uint8Array): boolean {
  const message=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));
  if (!message || Array.isArray(message) || message.jsonrpc!=='2.0') throw new Error('Invalid MCP message');
  if (message.method==='tools/call') {
    if (!message.params || typeof message.params.name!=='string') throw new Error('Tool name required');
    return !READ_TOOLS.has(message.params.name) && !READ_TASK_TOOLS.has(message.params.name);
  }
  if (message.method==='resources/read') {
    const uri=message.params?.uri;
    if(uri===approvalCardUri||uri===resultPreviewUri)return false;
    if (typeof uri!=='string' || !/^app:\/\/pcrc\/(?:device\/selected|activity\/recent|tasks\/recent|skills\/computer-use|files\/[A-Za-z0-9_./%~-]+|processes\/[A-Za-z0-9_-]+)$/.test(uri)) throw new Error('Resource denied');
    return uri.startsWith('app://pcrc/processes/');
  }
  if (!READ_METHODS.has(message.method)) throw new Error('Method denied');
  return false;
}
function validatedProtocolHeaders(request:Request,message:any):boolean {
  const version=request.headers.get('mcp-protocol-version');
  const bodyVersion=message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if(version!=='2026-07-28' && bodyVersion!=='2026-07-28')return true;
  if(version!=='2026-07-28'||bodyVersion!==version||request.headers.get('mcp-method')!==message.method)return false;
  const expected=message.method==='tools/call'||message.method==='prompts/get'?message.params?.name:message.method==='resources/read'?message.params?.uri:null;
  if(expected!==null){
    const raw=request.headers.get('mcp-name');
    if(typeof expected!=='string'||!raw)return false;
    const decoded=raw.startsWith('=?base64?')&&raw.endsWith('?=')?atob(raw.slice(9,-2)):raw;
    if(decoded!==expected)return false;
  }
  return true;
}
export function config(env: Settings) {
  const publicUrl = new URL(env.JAN_PUBLIC_ORIGIN);
  const origin = new URL(env.JAN_ORIGIN);
  const plain = (url: URL) => url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash;
  if (!plain(publicUrl) || !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(publicUrl.hostname)) throw new Error('Invalid Worker origin');
  if (!plain(origin) || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(origin.hostname)) throw new Error('Invalid tunnel origin');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(env.JAN_PROXY_KEY)) throw new Error('Invalid private proxy credential');
  if (!permittedAccount(env.ALLOWED_GITHUB_ID,env.ALLOWED_GITHUB_ID) || !/^[A-Za-z0-9_]{8,64}$/.test(env.GITHUB_CLIENT_ID) || (typeof env.GITHUB_CLIENT_SECRET!=='string' || env.GITHUB_CLIENT_SECRET.length<16 || env.GITHUB_CLIENT_SECRET.length>256) || ![undefined,'0','1'].includes(env.JAN_MULTI_USER_ENABLED) || ![undefined,'public','owner'].includes(env.JAN_SITE_ROLE) || env.JAN_BETA_GITHUB_IDS!==undefined&&(env.JAN_MULTI_USER_ENABLED!=='1'||!validBetaIds(env.JAN_BETA_GITHUB_IDS,env.ALLOWED_GITHUB_ID))) throw new Error('Owner authentication not configured');
  if(env.PCRC_OWNER_GITHUB_ID!==undefined&&authenticatedGitHubId(env.PCRC_OWNER_GITHUB_ID,env.PCRC_OWNER_GITHUB_ID)!==env.PCRC_OWNER_GITHUB_ID)throw new Error('Invalid owner GitHub identity');
  return {publicOrigin:publicUrl.origin,origin:origin.origin,resource:publicUrl.origin+'/mcp'};
}
const ORIGIN_RECORD='jan:active-origin:v1';
const ORIGIN_TTL=180;
const encoder=new TextEncoder();
export async function deviceKey(master:string,id:string):Promise<string> {
  const key=await crypto.subtle.importKey('raw',encoder.encode(master),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const raw=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode('JAN_DEVICE_KEY_V1\n'+id)));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function deviceState(env:Settings,accountId:string,path:string,data:unknown):Promise<any> {
  if(!env.DEVICES) throw Error('Device store unavailable');
  const stub=env.DEVICES.get(env.DEVICES.idFromName(accountId));
  const r=await stub.fetch('https://internal.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':accountId},body:JSON.stringify(data)});
  if(!r.ok) throw Error('Device state denied');
  return r.json();
}
function validTunnel(value: unknown): value is string {
  if (typeof value!=='string' || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(value)) return false;
  try {return new URL(value).origin===value;} catch {return false;}
}
async function originMac(key: string, origin: string, timestamp: number): Promise<Uint8Array> {
  const cryptoKey=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(`JAN_ORIGIN_V1\n${timestamp}\n${origin}`)));
}
function hex(data:Uint8Array):string {return Array.from(data,b=>b.toString(16).padStart(2,'0')).join('');}
export async function registerOrigin(request:Request,env:Settings,now=Math.floor(Date.now()/1000)):Promise<Response> {
  config(env);
  if (!env.OAUTH_KV || request.method!=='POST' || new URL(request.url).pathname!=='/jan-origin' ||
      request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') return failure(400,'Invalid registration');
  let data:unknown;
  try {data=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await boundedBody(request,512)));}
  catch {return failure(400,'Invalid registration');}
  if (!data || typeof data!=='object' || Array.isArray(data) || Object.keys(data).sort().join(',')!=='origin,signature,timestamp') return failure(400,'Invalid registration');
  const {origin,timestamp,signature}=data as Record<string,unknown>;
  if (!validTunnel(origin) || !Number.isSafeInteger(timestamp) || Math.abs(now-(timestamp as number))>60 ||
      typeof signature!=='string' || !/^[a-f0-9]{64}$/.test(signature)) return failure(403,'Registration denied');
  const expected=hex(await originMac(env.JAN_PROXY_KEY,origin,timestamp as number));
  // Fixed-length comparison; the HMAC itself is never returned or logged.
  let difference=0;for(let i=0;i<64;i++) difference|=expected.charCodeAt(i)^signature.charCodeAt(i);
  if(difference) return failure(403,'Registration denied');
  const previous=await env.OAUTH_KV.get(ORIGIN_RECORD,'json') as {origin?:string;timestamp?:number}|null;
  if (previous && Number.isSafeInteger(previous.timestamp) && (previous.timestamp as number)>=(timestamp as number)) return failure(409,'Newer registration exists');
  await env.OAUTH_KV.put(ORIGIN_RECORD,JSON.stringify({origin,timestamp}),{expirationTtl:ORIGIN_TTL});
  return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
}
export async function registerDeviceOrigin(request:Request,env:Settings,now=Math.floor(Date.now()/1000)):Promise<Response> {
  config(env);
  if(!env.DEVICES||request.method!=='POST'||new URL(request.url).pathname!=='/jan-device-origin'||request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') return failure(400,'Invalid device registration');
  let value:Record<string,unknown>;
  try {
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await boundedBody(request,768)));
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='device_id,origin,owner_id,signature,timestamp') throw Error();
  } catch {return failure(400,'Invalid device registration');}
  const {device_id:id,owner_id:ownerId,origin,timestamp,signature}=value;
  if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id)||ownerId!==env.ALLOWED_GITHUB_ID||!validTunnel(origin)||!Number.isSafeInteger(timestamp)||Math.abs(now-(timestamp as number))>60||typeof signature!=='string'||! /^[a-f0-9]{64}$/.test(signature)) return failure(403,'Device registration denied');
  const key=await deviceKey(env.JAN_PROXY_KEY,id);
  const signed=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const expected=hex(new Uint8Array(await crypto.subtle.sign('HMAC',signed,encoder.encode(`JAN_ORIGIN_V3\n${ownerId}\n${id}\n${timestamp}\n${origin}`))));
  let difference=0;for(let i=0;i<64;i++) difference|=expected.charCodeAt(i)^signature.charCodeAt(i);
  if(difference) return failure(403,'Device registration denied');
  try {
    const result=await deviceState(env,ownerId,'/device/register',{id,origin,timestamp});
    return Response.json({active:result.active},{headers:{'Cache-Control':'no-store'}});
  } catch {return failure(403,'Device registration denied');}
}
export async function activeOrigin(env:Settings,now=Math.floor(Date.now()/1000)):Promise<string|null> {
  const settings=config(env);
  if (env.JAN_AUTO_ORIGIN!=='1') return settings.origin;
  if (!env.OAUTH_KV) return null;
  const record=await env.OAUTH_KV.get(ORIGIN_RECORD,'json') as {origin?:unknown;timestamp?:unknown}|null;
  if (!record || !validTunnel(record.origin) || !Number.isSafeInteger(record.timestamp) ||
      (record.timestamp as number)>now+60 || now-(record.timestamp as number)>ORIGIN_TTL) return null;
  return record.origin;
}
async function activeTarget(env:Settings,accountId:string):Promise<{origin:string;key:string}|null> {
  if(env.DEVICES) {
    const state=await deviceState(env,accountId,'/device/active',{});
    if(state.enrolled) {
      if(!state.device||!validTunnel(state.device.origin)||typeof state.device.id!=='string') return null;
      return {origin:state.device.origin,key:await deviceKey(env.JAN_PROXY_KEY,state.device.id)};
    }
  }
  if(accountId!==env.ALLOWED_GITHUB_ID)return null;
  const origin=await activeOrigin(env);
  return origin?{origin,key:env.JAN_PROXY_KEY}:null;
}
export function escaped(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
export function failure(status: number, error: string): Response {
  return Response.json({error}, {status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const size=request.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size)>limit)) throw new Error('Body too large');
  if (!request.body) return new Uint8Array();
  const reader=request.body.getReader(); const chunks: Uint8Array[]=[]; let total=0;
  try {
    while (true) {
      const {done,value}=await reader.read(); if (done) break;
      total+=value.byteLength; if (total>limit) {await reader.cancel();throw new Error('Body too large');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const result=new Uint8Array(total); let offset=0;
  for (const chunk of chunks) {result.set(chunk,offset);offset+=chunk.length;}
  return result;
}
// Preserve tool errors during outages. No automatic mutation replay.
function unavailable(body: Uint8Array, code='ORIGIN_UNAVAILABLE', portal=''): Response {
  const message=JSON.parse(new TextDecoder().decode(body));
  const explanation=code==='DEVICE_NOT_SELECTED'?'No computer is selected. Sign in at '+portal+'/devices and choose Use this computer.':code==='DEVICE_OFFLINE'?'The selected computer is offline. Start PC-Remote-Commander.cmd on that computer and keep its terminal open.':code==='DEVICE_CAPABILITY_DENIED'?'The selected computer denied the requested capability. Review the approved device permissions before retrying.':'PCRC computer connection could not complete the request. Inspect the local launcher and verify the action outcome before retrying.';
  if (message.method==='tools/call' && (typeof message.id==='number' || typeof message.id==='string')) {
    return Response.json({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:JSON.stringify({
      error_code:code,error:explanation,automatic_retry:false
    })}],structuredContent:{ok:false,summary:explanation,error_code:code,data:{automatic_retry:false}}}},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  const response=failure(503,code==='DEVICE_NOT_SELECTED'||code==='DEVICE_OFFLINE'?explanation:'PCRC computer connection unavailable; inspect the local launcher');
  response.headers.set('Retry-After','5');return response;
}
export async function proxyMcp(request: Request, env: Settings, auth: {audience?:string;scope?:string[];userId?:string}, props: {githubId?:string;accountId?:string;authVersion?:number;confirmationHost?:unknown;confirmationVerified?:unknown}, fetcher: typeof fetch=fetch): Promise<Response> {
  const settings=config(env);
  const accountId=permittedAccount(authenticatedAccountId(auth.userId,props?.accountId??props?.githubId),env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS);
  if (auth.audience!==settings.resource || !accountId || !hasReadScope(auth.scope)) return failure(403,'Owner or scope denied');
  if(env.DEVICES) {
    const current=await deviceState(env,accountId,'/account/auth-version',{}).catch(()=>null);
    if(!current||!Number.isSafeInteger(current.authVersion)||current.authVersion<0)return failure(503,'Authentication state temporarily unavailable. Retry shortly.');
    if(current.resetting)return failure(503,'Password recovery is in progress. Reconnect after it completes.');
    if(!Number.isSafeInteger(props.authVersion??0)||current.authVersion!==(props.authVersion??0))return failure(401,'Sign-in changed. Reconnect PCRC in your assistant.');
    const limited=await authenticatedMcpRateLimit(accountId,env);if(limited)return limited;
  }
  const nativeHost=hasControlScope(auth.scope)&&(props.confirmationHost==='chatgpt'||props.confirmationHost==='claude')?props.confirmationHost:null;
  const url=new URL(request.url);
  if (url.origin!==settings.publicOrigin || url.pathname!=='/mcp' || url.search) return failure(400,'Invalid MCP URL');
  if (request.method!=='POST') return failure(405,'Stateless MCP uses POST');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') return failure(415,'JSON required');
  let body: Uint8Array;
  try {body=await boundedBody(request,MAX_BODY);} catch {return failure(413,'Request too large');}
  let toolCall=false, relayControl=false, methodName='';
  try {
    const message=JSON.parse(new TextDecoder().decode(body));
    methodName=READ_METHODS.has(message?.method)||['tools/call','resources/read','notifications/cancelled'].includes(message?.method)?message.method:'other';
    toolCall=message.method==='tools/call';
    if(!validatedProtocolHeaders(request,message))return failure(400,'MCP protocol headers disagree with request body');
    const actionControl=controlRequired(body);
    const controlCatalogRead=toolCall&&CONTROL_CATALOG_READ_TOOLS.has(message.params.name);
    if ((actionControl||controlCatalogRead) && !hasControlScope(auth.scope)) {
      const response=failure(403,'pcrc:control permission required; reconnect and explicitly approve computer control');
      response.headers.set('WWW-Authenticate',`Bearer error="insufficient_scope", resource_metadata="${settings.publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="pcrc:read pcrc:control"`);
      return response;
    }
    if((actionControl||controlCatalogRead)&&env.JAN_SITE_ROLE==='public'&&env.JAN_RELAY_ENABLED!=='1')return failure(503,'Computer control requires the protected device relay');
    relayControl=actionControl || controlCatalogRead || (hasControlScope(auth.scope) && ['tools/list','resources/list','resources/templates/list'].includes(message.method));
  } catch {
    // Metadata only: never log authorization headers, tool arguments, or content.
    console.warn('PC_REMOTE_MCP_REJECTED',JSON.stringify({method:methodName}));
    return failure(400,'Invalid or unsupported MCP message');
  }
  const version=request.headers.get('mcp-protocol-version');
  if(version && !/^\d{4}-\d{2}-\d{2}$/.test(version)) return failure(400,'Invalid protocol header');
  const requested=JSON.parse(new TextDecoder().decode(body));
  if(toolCall)try {inspectPublicOutput([requested.params?.arguments??{}],privacyRules);}catch(error) {
    return Response.json(privacyToolError(requested.id,error),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(nativeHost&&((toolCall&&['test_approval_dialog','test_approval_card'].includes(requested.params?.name))||(methodName==='resources/read'&&requested.params?.uri===approvalCardUri))){
    return Response.json({jsonrpc:'2.0',id:requested.id,result:{isError:true,content:[{type:'text',text:`PCRC custom approval diagnostics are disabled for this ${nativeHost==='chatgpt'?'ChatGPT':'Claude'} connection. Use the client's own tool confirmations. No computer action was authorized or executed.`}]}},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  // The account Durable Object is shared by every Worker isolate; public calls fail closed if it is unavailable.
  if(toolCall&&env.JAN_SITE_ROLE==='public'&&!env.DEVICES)return failure(503,'Usage service unavailable');
  if(toolCall&&env.DEVICES) {
    try {
      const stub=env.DEVICES.get(env.DEVICES.idFromName(accountId));
      const counted=await stub.fetch('https://internal.invalid/usage/increment',{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':accountId},body:'{}'});
      if(counted.status===429){
        const detail=await counted.json() as {resetsAt?:number};
        const monthly=Number.isFinite(detail.resetsAt)&&detail.resetsAt!>Date.now();
        const response=failure(429,monthly?'Monthly tool-call limit reached; resets on '+new Date(detail.resetsAt!).toISOString().slice(0,10)+' UTC':'Account tool-call limit reached; retry in one minute');
        response.headers.set('Retry-After',monthly?String(Math.ceil((detail.resetsAt!-Date.now())/1000)):'60');
        return response;
      }
      if(!counted.ok&&env.JAN_SITE_ROLE==='public')return failure(503,'Usage service unavailable');
    } catch {if(env.JAN_SITE_ROLE==='public')return failure(503,'Usage service unavailable');}
  }
  if(toolCall&&JSON.parse(new TextDecoder().decode(body)).params?.name==='test_approval_dialog') {
    return Response.json(approvalPreview(JSON.parse(new TextDecoder().decode(body))),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  const gatewayCall=JSON.parse(new TextDecoder().decode(body));
  if(toolCall&&gatewayCall.params?.name==='diagnose_connection'){
    const state=await deviceState(env,accountId,'/device/list',{}).catch(()=>null);
    const selected=Array.isArray(state?.devices)?state.devices.find((device:any)=>device.id===state.active&&!device.revoked):null;
    const status=!state?'unavailable':!selected?'not_selected':selected.online===true?'online':selected.online===false?'offline':'unknown';
    const nextStep={
      unavailable:'Check the PCRC dashboard; device state could not be read.',
      not_selected:'Sign in to the PCRC dashboard and select a computer for AI tools. Compare the account with the terminal.',
      offline:'Start PCRC on the selected computer and keep its terminal online.',
      online:'Check the runtime and required capabilities before running the requested tool.',
      unknown:'Check the selected computer terminal; relay status is unavailable.',
    }[status];
    const summary=nextStep+' The agent_version field is saved pairing metadata, not the current runtime version. Use get_connection_status on the live connection to inspect its runtime version.';
    return Response.json(privateToolResult({jsonrpc:'2.0',id:gatewayCall.id,result:{content:[{type:'text',text:summary}],
      structuredContent:{ok:true,summary,data:{account_id:accountId,status,
        agent_version:typeof selected?.agentVersion==='string'?selected.agentVersion:null,agent_version_source:'pairing_metadata',
        control_scope:hasControlScope(auth.scope),portal:settings.publicOrigin+'/devices'}}}}),
      {headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(toolCall&&gatewayCall.params?.name==='who_am_i'){
    const summary='Authenticated PCRC account';
    return Response.json(privateToolResult({jsonrpc:'2.0',id:gatewayCall.id,result:{content:[{type:'text',text:summary}],
      structuredContent:{ok:true,summary,data:{authenticated_pcrc_account:true,account_id:accountId}}}}),
      {headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(toolCall&&gatewayCall.params?.name==='test_approval_card')return Response.json(approvalCardResult(gatewayCall),{headers:{'Cache-Control':'no-store'}});
  if(methodName==='resources/read'&&gatewayCall.params?.uri===approvalCardUri)return Response.json(approvalCardResource(gatewayCall.id),{headers:{'Cache-Control':'no-store'}});
  if(methodName==='resources/read'&&gatewayCall.params?.uri===resultPreviewUri)return Response.json(resultPreviewResource(gatewayCall.id),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(toolCall&&JSON.parse(new TextDecoder().decode(body)).params?.name==='get_action_result') {
    if(!env.DEVICES)return failure(503,'Action results unavailable');
    return Response.json(privateToolResult(await readActionResult(JSON.parse(new TextDecoder().decode(body)),env.DEVICES.get(env.DEVICES.idFromName(accountId)),accountId)),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(env.JAN_RELAY_ENABLED==='1') {
    if(!env.DEVICES) return unavailable(body,'RELAY_UNAVAILABLE');
    const message={type:'request',request_id:crypto.randomUUID(),control:relayControl,payload:new TextDecoder().decode(body)};
    try {
      const stub=env.DEVICES.get(env.DEVICES.idFromName(accountId));
      const relayHeaders=new Headers({'Content-Type':'application/json','X-Jan-Account-Id':accountId});
      if(nativeHost){relayHeaders.set('X-PCRC-Host-Confirmation',nativeHost);if(props.confirmationVerified===true)relayHeaders.set('X-PCRC-Host-Verified','1');}
      const result=await stub.fetch('https://internal.invalid/relay/dispatch',{method:'POST',headers:relayHeaders,body:JSON.stringify(message)});
      if(!result.ok) {
        let code='RELAY_UNAVAILABLE';
        let reason='other';
        try {
          const detail=await result.json() as {error?:string};
          if(['No selected approved device','Selected device offline','Invalid relay request','Device capability denied','Device did not complete request; outcome unknown, do not retry mutations automatically'].includes(detail.error??'')) reason=detail.error!;
          if(detail.error==='No selected approved device')code='DEVICE_NOT_SELECTED';
          else if(detail.error==='Selected device offline')code='DEVICE_OFFLINE';
          else if(detail.error==='Device capability denied')code='DEVICE_CAPABILITY_DENIED';
        } catch {}
        console.warn('PC_REMOTE_RELAY_RESPONSE',JSON.stringify({status:result.status,reason}));
        return unavailable(body,code,settings.publicOrigin);
      }
      const reply=await result.json() as {type?:string;request_id?:string;status?:number;payload?:string};
      if(reply.type!=='response'||reply.request_id!==message.request_id||![200,202,204].includes(reply.status??0)||typeof reply.payload!=='string') return unavailable(body,'RELAY_INVALID_RESPONSE');
      if(reply.status===202||reply.status===204) return new Response(null,{status:reply.status,headers:{'Cache-Control':'no-store'}});
      let bytes:Uint8Array;
      try {bytes=clientPayload(reply.payload,methodName,Boolean(nativeHost),gatewayCall);}catch{return unavailable(body,'RELAY_INVALID_RESPONSE');}
      return new Response(bytes,{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    } catch {return unavailable(body,'RELAY_UNAVAILABLE');}
  }
  const target=await activeTarget(env,accountId).catch(()=>null);
  if(!target) return unavailable(body);
  const headers=new Headers({'Authorization':'Bearer '+target.key,'Content-Type':'application/json','Accept':'application/json, text/event-stream'});
  headers.set('X-JAN-Control',hasControlScope(auth.scope)?'1':'0');
  if(version) headers.set('MCP-Protocol-Version',version);
  if(version==='2026-07-28') {
    for(const name of ['Mcp-Method','Mcp-Name']) {
      const value=request.headers.get(name);
      if(value)headers.set(name,value);
    }
  }
  try {
    const response=await fetcher(target.origin+'/mcp',{method:'POST',headers,body:body as BodyInit,redirect:'manual',signal:AbortSignal.timeout(20000)});
    if (response.status===202 || response.status===204) return new Response(null,{status:response.status,headers:{'Cache-Control':'no-store'}});
    if (response.status>=300 && response.status<400) return failure(502,'Local origin redirect denied');
    if (!response.ok) return unavailable(body,response.status===401 || response.status===403?'ORIGIN_AUTH_UNAVAILABLE':'ORIGIN_UNAVAILABLE');
    if (response.headers.get('content-type')?.split(';')[0].trim()!=='application/json') return unavailable(body,'ORIGIN_INVALID_RESPONSE');
    const data=await boundedBody(new Request('https://response.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),MAX_RESPONSE);
    const presented=clientPayload(new TextDecoder().decode(data),methodName,Boolean(nativeHost));
    return new Response(presented as BodyInit,{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  } catch {return unavailable(body);}
}
