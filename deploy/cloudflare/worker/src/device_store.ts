import {ownerSecurityStore} from './owner_security.ts';
import {ownerDataStore,indexMember,removeMemberIndex,supportStore,validOperator,type MemberMeta} from './owner_data.ts';
import {connectedCapacity,expireConnectedCapacity} from './connected_capacity.ts';
import {signInReturn} from './portal_return.ts';
import {websitePromptStore} from './website_prompts.ts';
import {consumePublicBudget,expirePublicBudget} from './public_rate_limit.ts';
import {beginDeletion,finishDeletion,deletionState,retainAccountData} from './account_lifecycle.ts';
/** Private, strongly consistent state for owner sessions, device enrollment and usage. */
import {JanRelayUpgrade} from './relay_upgrade.ts';
import {dispatchSelected} from './relay_dispatch.ts';
import {CONTROL_CATALOG_READ_TOOLS,validateRelayRequest} from './relay_protocol.ts';
import {requiresWebsiteApproval} from './native_confirmation.ts';
import {actionAccess,type PendingAction} from './action_access.ts';
import {pairingStore} from './pairing.ts';
import {verifyTransfer} from './transfer_access.ts';
import {authenticatedAccountId,authenticatedGitHubId,permittedAccount,validEmailUsername} from './account_identity.ts';
import {openRecord,sealRecord,type SealedRecord} from './secure_store.ts';
type Entry = Record<string,unknown>;
type Activity = {at:number;deviceId:string;tool:string;outcome:'completed'|'tool error'|'unavailable';durationMs:number};
type ActionApproval = {id:string;digest:string;deviceId:string;expires:number;status:'pending'|'approved'|'denied';sealed:SealedRecord;autoRun?:boolean;executionId?:string};
type ActionReceipt = {deviceId:string;expires:number;status:'running'|'completed'|'unknown';sealed:SealedRecord;parts?:number};
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
type DirectoryAlias=string|{ids:string[]};
function aliasIds(value:DirectoryAlias|undefined):string[] {
  return typeof value==='string'?[value]:Array.isArray(value?.ids)?value.ids:[];
}
async function removeDirectoryAlias(tx:DurableObjectTransaction,key:string,id:string):Promise<void> {
  const ids=aliasIds(await tx.get<DirectoryAlias>(key)).filter(value=>value!==id);
  if(!ids.length)await tx.delete(key);else await tx.put(key,ids.length===1?ids[0]:{ids});
}
const MONTHLY_CALL_LIMIT=15000;
type Usage = {started:number;days:Record<string,number>};
type Subscription = {id:string;eventId:string;occurredAt:number;status:string;priceId:string;cancelAt?:string|null};
type Subscriptions = Record<string,Subscription>;
const isPro=(subscriptions:Subscriptions|null,priceId:string|undefined)=>!!priceId&&Object.values(subscriptions??{}).some(item=>item.status==='active'&&item.priceId===priceId);
function monthlyUsage(usage:Usage|null,now:number) {
  const date=new Date(now),month=date.toISOString().slice(0,7);
  return {used:Object.entries(usage?.days??{}).filter(([day])=>day.startsWith(month)).reduce((sum,[,count])=>sum+count,0),limit:MONTHLY_CALL_LIMIT,resetsAt:Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)};
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const reviewArgs=(args:unknown):unknown=>args&&typeof args==='object'&&!Array.isArray(args)?Object.fromEntries(Object.entries(args).map(([key,value])=>[key,key==='lease_token'?'[assignment token hidden]':value])):args;
async function actionDigest(secret:string,accountId:string,deviceId:string,name:string,args:unknown):Promise<string> {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify([accountId,deviceId,name,canonical(args)])));
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
}
function actionError(input:{payload:string;request_id?:string},message:string,url?:string):Response {
  const call=JSON.parse(input.payload) as {id?:string|number};
  return json({type:'response',request_id:(input as {request_id?:string}).request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:call.id,result:{isError:true,content:[{type:'text',text:message+(url?' Open '+url+' and approve the exact action. New requests run once after website approval. Do not resend this mutation. Use get_action_result with action_id '+new URL(url).searchParams.get('id')+' to check its result.':'')}]}})});
}
const taskToolNames = new Set([
  'inspect_development','preview_development_change','apply_development_change','get_development_change',
  'inspect_document_pdf',
  'preview_document_workflow','apply_document_workflow','get_document_workflow',
  'read_pdf','rewrite_pdf','create_pdf','create_directory','read_multiple_files','get_more_search_results','list_searches','stop_search','list_processes','force_terminate','get_config','set_config_value','shutdown','who_am_i',
  'inspect_media','edit_media','transcribe_audio','prepare_media',
  'list_tasks','create_task','claim_task','renew_task','finish_task','reconcile_task','list_workflows','inspect_workflow','teach_browser_workflow','publish_workflow','delete_workflow','start_workflow_run','run_workflow_step',
  'get_connection_status','get_capabilities','get_recent_activity','list_workspace_entries','search_workspace',
  'inspect_file','read_file_excerpt','compare_files','preview_file_edit','apply_file_edit','create_text_file',
  'move_files_bulk','delete_files_bulk','restore_file_backup','run_diagnostic','run_command','start_process','start_program','list_applications','open_application',
  'read_process_output','send_process_input','stop_process','list_browser_tabs','inspect_browser_page','capture_browser',
  'navigate_browser','interact_browser','manage_browser_tab','capture_desktop','interact_desktop','inspect_desktop_controls','interact_desktop_control','suggest_workflow','list_skill_packs',
]);
function toolMetadata(input:unknown):string|null {
  if(!input||typeof input!=='object'||Array.isArray(input)) return null;
  const envelope=input as {payload?:unknown};
  if(typeof envelope.payload!=='string') return null;
  try {
    const message=JSON.parse(envelope.payload) as {method?:unknown;params?:{name?:unknown}};
    const name=message.params?.name;
    return message.method==='tools/call'&&typeof name==='string'&&(/^jan_[a-z0-9_]{1,48}$/.test(name)||taskToolNames.has(name))?name:null;
  } catch {return null;}
}
async function emailIndex(secret:string,email:string):Promise<string> {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('PCRC_EMAIL_INDEX_V1\n'+email))),b=>b.toString(16).padStart(2,'0')).join('');
}
export class JanDeviceStore {
  async alarm():Promise<void> {await expirePublicBudget(this.state.storage);await expireConnectedCapacity(this.state.storage);}
  private state:DurableObjectState;
  private relay:JanRelayUpgrade;
  private env:{ALLOWED_GITHUB_ID:string;PCRC_OWNER_GITHUB_ID?:string;JAN_PROXY_KEY:string;JAN_PUBLIC_ORIGIN?:string;JAN_PAIRING_ENABLED?:string;JAN_MULTI_USER_ENABLED?:string;JAN_BETA_GITHUB_IDS?:string;PADDLE_PRICE_ID?:string;DEVICES?:DurableObjectNamespace};
  constructor(state:DurableObjectState,env:{ALLOWED_GITHUB_ID:string;PCRC_OWNER_GITHUB_ID?:string;JAN_PROXY_KEY:string;JAN_PUBLIC_ORIGIN?:string;JAN_PAIRING_ENABLED?:string;JAN_MULTI_USER_ENABLED?:string;JAN_BETA_GITHUB_IDS?:string;PADDLE_PRICE_ID?:string;DEVICES?:DurableObjectNamespace}) {this.state=state;this.env=env;this.relay=new JanRelayUpgrade(env);}
  private async effectivePro(storage:DurableObjectStorage|DurableObjectTransaction=this.state.storage,inTransaction=false):Promise<boolean>{
    if(!inTransaction)return (storage as DurableObjectStorage).transaction(tx=>this.effectivePro(tx,true));
    const grant=await storage.get<{until:number}>('billing:complimentary:v1'),paid=isPro(await storage.get<Subscriptions>('billing:subscriptions:v1')??null,this.env.PADDLE_PRICE_ID);
    if(grant&&grant.until<=Date.now()){await storage.delete('billing:complimentary:v1');await storage.put('billing:plan-revision:v1',(await storage.get<number>('billing:plan-revision:v1')??0)+1);if(!paid)await this.enforceFreeDevices(storage);}
    return !!grant&&grant.until>Date.now()||paid;
  }
  private async enforceFreeDevices(storage:DurableObjectStorage|DurableObjectTransaction){
    const devices=await storage.get<Record<string,Entry>>('devices')??{},active=await storage.get<string>('active');
    const enabled=Object.values(devices).filter(d=>!d.revoked).sort((a,b)=>Number(b.id===active)-Number(a.id===active)||Number(a.created??0)-Number(b.created??0)||String(a.id).localeCompare(String(b.id)));
    for(const device of enabled.slice(1)){device.revoked=true;device.revokedAt=Date.now();this.relay.disconnect(String(device.id));}
    await storage.put('devices',devices);
  }
  private async planState(){return this.state.storage.transaction(async tx=>{const pro=await this.effectivePro(tx,true),paid=isPro(await tx.get<Subscriptions>('billing:subscriptions:v1')??null,this.env.PADDLE_PRICE_ID),grant=await tx.get<{until:number}>('billing:complimentary:v1');return {pro,revision:await tx.get<number>('billing:plan-revision:v1')??0,validUntil:pro&&!paid?grant?.until??null:null};});}
  private async syncPlan(accountId:string):Promise<boolean>{
    if(this.env.JAN_MULTI_USER_ENABLED!=='1'||!this.env.DEVICES)return true;
    const state=await this.planState(),hub=this.env.DEVICES.get(this.env.DEVICES.idFromName(this.env.ALLOWED_GITHUB_ID));
    const response=await hub.fetch('https://internal.invalid/pairing/plan',{method:'POST',headers:{'X-Jan-Account-Id':this.env.ALLOWED_GITHUB_ID,'Content-Type':'application/json'},body:JSON.stringify({ownerId:accountId,...state})});
    return response.ok;
  }
  private async installationAccess(accountId:string,device:Entry,devices:Record<string,Entry>):Promise<boolean>{
    if(this.env.JAN_MULTI_USER_ENABLED!=='1')return true;
    const {pro,revision,validUntil}=await this.planState();
    if(!pro){
      const active=await this.state.storage.get<string>('active');
      const candidates=Object.values(devices).filter(d=>!d.revoked).sort((a,b)=>Number(b.id===active)-Number(a.id===active)||Number(a.created??0)-Number(b.created??0)||String(a.id).localeCompare(String(b.id)));
      if(candidates[0]?.id!==device.id)return false;
    }
    if(!this.env.DEVICES||typeof device.publicKey!=='string')return true;
    const hub=this.env.DEVICES.get(this.env.DEVICES.idFromName(this.env.ALLOWED_GITHUB_ID));
    const response=await hub.fetch('https://internal.invalid/pairing/access',{method:'POST',headers:{'X-Jan-Account-Id':this.env.ALLOWED_GITHUB_ID,'Content-Type':'application/json'},body:JSON.stringify({ownerId:accountId,publicKey:device.publicKey,pro,revision,validUntil})});
    return response.ok&&(await response.json() as {allowed?:boolean}).allowed===true;
  }
  async fetch(request:Request):Promise<Response> {
    if(new URL(request.url).pathname==='/capacity/account')return connectedCapacity(request,this.state.storage);
    if(new URL(request.url).pathname==='/abuse/check')return consumePublicBudget(request,this.state.storage);
    if(new URL(request.url).pathname==='/health/check') {
      await this.state.storage.get('health:v1');
      return new Response(null,{status:204});
    }
    const accountId=permittedAccount(request.headers.get('X-Jan-Account-Id')??(this.env.JAN_MULTI_USER_ENABLED==='1'?null:this.env.ALLOWED_GITHUB_ID),this.env.ALLOWED_GITHUB_ID,this.env.JAN_MULTI_USER_ENABLED,this.env.JAN_BETA_GITHUB_IDS);
    if(!accountId)return json({error:'Account denied'},403);
    const ownsStore=await this.state.storage.transaction(async tx=>{
      const bound=await tx.get<string>('account:owner:v1');
      if(bound!==undefined)return bound===accountId;
      await tx.put('account:owner:v1',accountId);return true;
    });
    if(!ownsStore)return json({error:'Account denied'},403);
    const lifecycle=await deletionState(this.state.storage);
    const route=new URL(request.url).pathname;
    if(route==='/account/deletion-state')return json(lifecycle);
    if((lifecycle.closing||lifecycle.deleted)&&route==='/billing/subscription')return json({ok:true,ignored:true});
    if(lifecycle.deleted&&route!=='/account/delete-finish'&&route!=='/account/retention')return json({error:'Account deleted'},410);
    if(lifecycle.closing&&!['/account/delete-start','/account/delete-finish','/account/retention','/session/get','/session/delete'].includes(route))return json({error:'Account deletion in progress'},410);
    if(new URL(request.url).pathname==='/relay/connect') {
      return this.relay.handle(request,async id=>{
        const state=await deletionState(this.state.storage);
        if(state.closing||state.deleted)return false;
        const devices=await this.state.storage.get<Record<string,Entry>>('devices')??{};
        if(devices[id]&&!await this.installationAccess(accountId,devices[id],devices))return false;
        return devices[id]&&!devices[id].revoked&&(devices[id].ownerId===accountId||accountId===this.env.ALLOWED_GITHUB_ID&&!devices[id].ownerId)?(devices[id].publicKey as string??true):false;
      },async nonce=>this.state.storage.transaction(async tx=>{
        const used=await tx.get<Record<string,number>>('relay:nonces')??{};
        const now=Date.now();for(const [key,expires] of Object.entries(used)) if(expires<=now) delete used[key];
        if(used[nonce]||Object.keys(used).length>=4096) return false;
        used[nonce]=now+180000;await tx.put('relay:nonces',used);return true;
      }),accountId,async id=>{
        const devices=await this.state.storage.get<Record<string,Entry>>('devices')??{};
        return devices[id]?.login;
      });
    }
    if(request.method!=='POST') return json({error:'Method denied'},405);
    const path=new URL(request.url).pathname;
    if(path==='/transfer/verify') {
      const proof:unknown=await request.json().catch(()=>null);
      const verified=await verifyTransfer(proof,accountId,async (source,destination)=>{
        const devices=await this.state.storage.get<Record<string,Entry>>('devices')??{};
        const keyFor=(id:string)=>{
          const device=devices[id];
          return device?.ownerId===accountId&&!device.revoked&&typeof device.publicKey==='string'&&
            Array.isArray(device.capabilities)&&device.capabilities.includes('files')&&
            this.relay.getSession(id)?.online?device.publicKey:null;
        };
        return [keyFor(source),keyFor(destination)];
      });
      return verified?new Response(null,{status:204,headers:{'Cache-Control':'no-store'}}):json({error:'Transfer denied. Both devices must be online, enrolled to the same account, and approved for files.'},403);
    }
    if(path==='/relay/dispatch') {
      let input:unknown;
      try {
        const raw=await request.text();
        if(new TextEncoder().encode(raw).byteLength>263000) return json({error:'Relay body too large'},413);
        input=JSON.parse(raw);
      } catch {return json({error:'Invalid relay body'},400);}
      const active=await this.state.storage.get<string>('active')??null;
      const devices=await this.state.storage.get<Record<string,Entry>>('devices')??{};
      let envelope;
      try {envelope=validateRelayRequest(input);} catch {return json({error:'Invalid relay request'},400);}
      if(active&&devices[active]&&!devices[active].revoked&&!await this.installationAccess(accountId,devices[active],devices)){this.relay.disconnect(active);return json({error:'Free accounts support one computer on its original account. Shared installations require Pro.'},403);}
      // Public clients can register a host callback without proving they control it.
      let hostConfirmation=(!requiresWebsiteApproval(this.env)||request.headers.get('X-PCRC-Host-Verified')==='1')&&['chatgpt','claude'].includes(request.headers.get('X-PCRC-Host-Confirmation')??'');
      if(hostConfirmation&&envelope.control&&active&&devices[active]&&!devices[active].revoked){
        const call=JSON.parse(envelope.payload) as {method:string;params?:{name?:string;arguments?:unknown}};
        if(call.method==='tools/call'&&typeof call.params?.name==='string'&&!CONTROL_CATALOG_READ_TOOLS.has(call.params.name)){
          const digest=await actionDigest(this.env.JAN_PROXY_KEY,accountId,active,call.params.name,call.params.arguments??{});
          const blocked=await this.state.storage.transaction(async tx=>{
            const items=await tx.get<ActionApproval[]>('actions:v1')??[];
            const same=items.find(item=>item.deviceId===active&&item.digest===digest&&item.expires>Date.now());
            if(same&&same.status!=='pending')return same;
            if(same)await tx.put('actions:v1',items.filter(item=>item.id!==same.id));
            return null;
          });
          if(blocked)return actionError(input as {payload:string},blocked.status==='denied'?'The account holder denied this exact pending action.':'This exact action is already running. Do not repeat it. Use get_action_result with action_id '+blocked.id+'.');
        }
      }
      if(!hostConfirmation&&envelope.control===true&&typeof envelope.payload==='string'&&active&&devices[active]&&!devices[active].revoked) {
        let call:{method?:string;params?:{name?:string;arguments?:unknown;_meta?:unknown}};
        try {call=JSON.parse(envelope.payload);} catch {return json({error:'Invalid relay request'},400);}
        if(call.method==='tools/call'&&typeof call.params?.name==='string'&&!CONTROL_CATALOG_READ_TOOLS.has(call.params.name)&&
          !(['move_files_bulk','delete_files_bulk'].includes(call.params.name)&&(call.params.arguments as {dry_run?:unknown}|undefined)?.dry_run===true)) {
          const args=call.params.arguments??{};
          // shortcut: browser review caps arguments at 16 KiB; use smaller calls until a large-payload review UI exists.
          if(new TextEncoder().encode(JSON.stringify(args)).length>16384)return actionError(input as {payload:string},'Action too large for browser review. Split it into smaller calls.');
          if(new TextEncoder().encode(JSON.stringify(call.params._meta??{})).length>4096)return actionError(input as {payload:string},'Action metadata is too large. Start a new tool call with less metadata.');
          if(!this.relay.getSession(active)?.online)return json({error:'Selected device offline'},503);
          const digest=await actionDigest(this.env.JAN_PROXY_KEY,accountId,active,call.params.name,args);
          const approval=await this.state.storage.transaction(async tx=>{
            const items=await tx.get<ActionApproval[]>('actions:v1')??[];
            const live=items.filter(item=>item.expires>Date.now());
            let item=live.find(item=>item.digest===digest&&item.deviceId===active);
            if(item?.status==='approved') {
              if(item.autoRun&&request.headers.get('X-Jan-Action-Execution')!==item.executionId)return {status:'running' as const,id:item.id};
              await tx.put('actions:v1',live.filter(candidate=>candidate.id!==item!.id));
              return {status:'approved' as const};
            }
            if(!item) {
              if(live.length>=8)return {status:'limit' as const};
              const id=crypto.randomUUID();
              item={id,digest,deviceId:active,expires:Date.now()+300000,status:'pending',autoRun:true,sealed:await sealRecord(this.env.JAN_PROXY_KEY,accountId,'action-approval',{name:call.params!.name,args,meta:call.params!._meta??null},Date.now()+300000)};
              live.push(item);
            }
            if(new TextEncoder().encode(JSON.stringify(live)).length>120000)return {status:'limit' as const};
            await tx.put('actions:v1',live);
            return {status:item.status,id:item.id};
          });
          if(approval.status==='limit')return actionError(input as {payload:string},'Too many pending actions. Review or wait for earlier requests to expire.');
          if(approval.status==='running')return actionError(input as {payload:string},'This action is already queued. Do not resend it. Use get_action_result with action_id '+approval.id+'.');
          if(approval.status==='denied')return actionError(input as {payload:string},'The account holder denied this action.');
          if(approval.status==='pending')return actionError(input as {payload:string},'Action paused. No change has been made.',this.env.JAN_PUBLIC_ORIGIN+'/devices/actions?id='+approval.id);
        }
      }
      const started=Date.now();
      const closing=await deletionState(this.state.storage);
      if(closing.closing||closing.deleted)return json({error:'Account access closed'},410);
      const response=await dispatchSelected(input,active,devices,id=>this.relay.getSession(id));
      const tool=toolMetadata(input);
      if(tool&&active&&devices[active]&&!devices[active].revoked) try {
        let outcome:Activity['outcome']=response.ok?'completed':'unavailable';
        if(response.ok) {
          try {
            const reply=await response.clone().json() as {payload?:string};
            if(typeof reply.payload==='string'&&(JSON.parse(reply.payload) as {result?:{isError?:boolean}}).result?.isError===true) outcome='tool error';
          } catch {outcome='unavailable';}
        }
        await this.state.storage.transaction(async tx=>{
          if(await tx.get('account:closing:v1')||await tx.get('account:deleted:v1'))return;
          const items=await tx.get<Activity[]>('activity:recent:v1')??[];
          items.push({at:started,deviceId:active,tool,outcome,durationMs:Math.min(30000,Math.max(0,Date.now()-started))});
          await tx.put('activity:recent:v1',items.slice(-50));
          const current=await tx.get<Record<string,Entry>>('devices')??{};
          if(current[active]) {current[active].calls=(Number(current[active].calls)||0)+1;await tx.put('devices',current);}
        });
      } catch {}
      return response;
    }
    let body:Entry,rawBody='';
    try {
      const raw=rawBody=await request.text();
      if(raw.length>(path.startsWith('/owner-data/')||path.startsWith('/support/')||path.startsWith('/operator/')?32768:4096)) return json({error:'Too large'},413);
      body=JSON.parse(raw);
      if(!body || Array.isArray(body) || typeof body!=='object') throw Error();
    } catch {return json({error:'Invalid request'},400);}
    const now=Date.now(), storage=this.state.storage;
    const security=await ownerSecurityStore(path,body,storage,this.env,accountId);if(security)return security;
    const ownerData=await ownerDataStore(path,body,storage,this.env,accountId);if(ownerData)return ownerData;
    if(path.startsWith('/support/'))return (await supportStore(path,{...body,operator:false},storage,this.env,accountId))!;
    if(path.startsWith('/operator/')){
      if(!await validOperator(request,this.env,accountId,rawBody))return json({error:'Operator proof required'},403);
      if(path==='/operator/detail')return json({grant:await storage.get('billing:complimentary:v1')??null});
      if(path==='/operator/support/list'||path==='/operator/support/get'||path==='/operator/support/reply')return (await supportStore(path.replace('/operator',''),{...body,operator:true},storage,this.env,accountId))!;
      if(path!=='/operator/pro')return json({error:'Unknown operator action'},404);
      if(typeof body.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(body.nonce)||typeof body.until!=='number'||body.until!==0&&(body.until<=now||body.until>now+366*86400000)||typeof body.reason!=='string'||body.reason.length>120)return json({error:'Invalid Pro grant'},400);
      const changed=await storage.transaction(async tx=>{
        if(await tx.get('operator:nonce:'+body.nonce))return json({error:'Action already applied; inspect current account'},409);
        await tx.put('operator:nonce:'+body.nonce,{at:now,expires:now+300000});
        if(body.until===0)await tx.delete('billing:complimentary:v1');else await tx.put('billing:complimentary:v1',{until:body.until,reason:body.reason,grantedAt:now});
        if(!await this.effectivePro(tx,true))await this.enforceFreeDevices(tx);
        await tx.put('billing:plan-revision:v1',(await tx.get<number>('billing:plan-revision:v1')??0)+1);return json({ok:true});
      });
      if(changed.ok&&!await this.syncPlan(accountId))return json({error:'Grant saved; pairing synchronization unavailable. Inspect the account before another action.'},503);
      return changed;
    }

    if(path==='/account/delete-start') {
      if(accountId===this.env.ALLOWED_GITHUB_ID)return json({error:'Operator account cannot be deleted here'},403);
      const result=await beginDeletion(storage,body.confirmation);
      if(result.ok)for(const id of Object.keys(await storage.get<Record<string,Entry>>('devices')??{}))this.relay.disconnect(id);
      return result;
    }
    if(path==='/account/delete-finish') {
      if(accountId===this.env.ALLOWED_GITHUB_ID)return json({error:'Operator account cannot be deleted here'},403);
      return finishDeletion(storage);
    }
    if(path==='/account/retention'){await retainAccountData(storage);if(!lifecycle.deleted&&!lifecycle.closing&&!await this.syncPlan(accountId))return json({error:'Plan synchronization unavailable'},503);return json({ok:true});}
    if(path.startsWith('/website-prompts/'))return websitePromptStore(storage,path,body,accountId,this.env.ALLOWED_GITHUB_ID);
    if(path==='/billing/subscription') {
      if(typeof body.id!=='string'||!/^sub_[a-z0-9]{26}$/.test(body.id)||typeof body.eventId!=='string'||!/^evt_[a-z0-9]{26}$/.test(body.eventId)||
        typeof body.occurredAt!=='number'||!Number.isFinite(body.occurredAt)||typeof body.status!=='string'||typeof body.priceId!=='string'||body.accountId!==accountId)return json({error:'Invalid billing event'},400);
      const result=await storage.transaction(async tx=>{
        const subscriptions=await tx.get<Subscriptions>('billing:subscriptions:v1')??{};
        const previous=subscriptions[body.id as string];
        if(previous&&(body.occurredAt as number)<=previous.occurredAt)return json({ok:true,duplicate:true});
        subscriptions[body.id as string]={id:body.id as string,eventId:body.eventId as string,occurredAt:body.occurredAt as number,status:body.status as string,priceId:body.priceId as string,cancelAt:typeof body.cancelAt==='string'?body.cancelAt:null};
        await tx.put('billing:subscriptions:v1',subscriptions);
        await tx.put('billing:plan-revision:v1',(await tx.get<number>('billing:plan-revision:v1')??0)+1);
        if(!await this.effectivePro(tx,true)){
          await this.enforceFreeDevices(tx);
        }
        return json({ok:true});
      });
      if(result.ok&&!await this.syncPlan(accountId))return json({error:'Plan synchronization unavailable'},503);
      return result;
    }
    if(path==='/billing/summary')return json(Object.values(await storage.get<Subscriptions>('billing:subscriptions:v1')??{}).map(({id,status,priceId,cancelAt})=>({id,status,priceId,cancelAt:cancelAt??null})));
    if(path==='/billing/admin-state') {
      if(typeof body.id!=='string'||!/^sub_[a-z0-9]{26}$/.test(body.id)||!['active','canceled'].includes(String(body.status))||body.cancelAt!==null&&!(typeof body.cancelAt==='string'&&Number.isFinite(Date.parse(body.cancelAt))))return json({error:'Invalid billing state'},400);
      const result=await storage.transaction(async tx=>{
        const subscriptions=await tx.get<Subscriptions>('billing:subscriptions:v1')??{};
        const current=subscriptions[body.id as string];
        if(!current)return json({error:'Subscription unavailable'},404);
        subscriptions[body.id as string]={...current,status:body.status as string,cancelAt:body.cancelAt as string|null,occurredAt:now};
        await tx.put('billing:subscriptions:v1',subscriptions);
        await tx.put('billing:plan-revision:v1',(await tx.get<number>('billing:plan-revision:v1')??0)+1);
        return json({ok:true});
      });
      if(result.ok&&!await this.syncPlan(accountId))return json({error:'Plan synchronization unavailable'},503);
      return result;
    }
    if(path==='/billing/refund-lock') {
      if(typeof body.id!=='string'||!/^sub_[a-z0-9]{26}$/.test(body.id)||typeof body.transaction!=='string'||!/^txn_[a-z0-9]{26}$/.test(body.transaction))return json({error:'Invalid refund'},400);
      return storage.transaction(async tx=>{
        const subscriptions=await tx.get<Subscriptions>('billing:subscriptions:v1')??{};
        if(!subscriptions[body.id as string]||await tx.get('billing:refund-lock:'+body.transaction))return json({error:'Refund already requested or unavailable'},409);
        await tx.put('billing:refund-lock:'+body.transaction,{subscriptionId:body.id,at:now});
        return json({ok:true});
      });
    }
    if(path==='/connection/check') {
      const devices=await storage.get<Record<string,Entry>>('devices')??{};
      const paired=Object.values(devices).some(device=>!device.revoked);
      const active=await storage.get<string>('active'),device=active?devices[active]:undefined;
      const selected=!!device&&!device.revoked,online=!!active&&selected&&this.relay.getSession(active)?.online===true;
      const checks=[
        {step:'Paired computer',status:paired?'pass':'fail',help:'Run the setup command and approve the matching computer code.'},
        {step:'Selected computer',status:selected?'pass':'fail',help:'Select your computer on the Devices dashboard using this same account.'},
        {step:'Agent relay',status:online?'pass':'fail',help:'Keep the PCRC terminal Online. Check internet access and restart setup if disconnected.'},
      ];
      let toolCount:number|null=null,discovery='not tested';
      if(body.discover===true&&online) {
        try {
          // Dashboard session already proved account ownership. This never calls a tool.
          const response=await dispatchSelected({type:'request',request_id:crypto.randomUUID(),control:Array.isArray(device!.capabilities)&&device!.capabilities.includes('control'),payload:JSON.stringify({jsonrpc:'2.0',id:'pcrc-connection-check',method:'tools/list',params:{}})},active!,devices,id=>this.relay.getSession(id));
          if(response.ok) {
            const envelope=await response.json() as {payload:string},reply=JSON.parse(envelope.payload);
            if(!Array.isArray(reply?.result?.tools))throw Error();
            const count:number=reply.result.tools.length;toolCount=count;discovery=count>0?'pass':'fail';
          }else discovery='fail';
        }catch {discovery='fail';}
      }
      checks.push({step:'Live MCP tool discovery',status:discovery,help:'Run this check while the selected computer is Online. If discovery fails, restart setup; if only your assistant fails after OAuth, reconnect it using the same PCRC account.'});
      return json({checks,toolCount,computer:selected?String(device!.name??'Computer'):null,assistantOAuth:'Not tested by this browser session. An authenticated assistant tool call is required.'});
    }
    if(path==='/actions/list') {
      const active=await storage.get<string>('active');
      const devices=await storage.get<Record<string,Entry>>('devices')??{};
      if(!active||!devices[active]||devices[active].revoked)return json({items:[]});
      const items:PendingAction[]=[];
      for(const item of await storage.get<ActionApproval[]>('actions:v1')??[]) {
        if(item.deviceId!==active||item.status!=='pending'||item.expires<=now)continue;
        try {
          const details=await openRecord<{name:string;args:unknown}>(this.env.JAN_PROXY_KEY,accountId,'action-approval',item.sealed);
          items.push({id:item.id,name:details.name,args:reviewArgs(details.args),deviceName:String(devices[active].name??'Computer'),expires:item.expires,access:actionAccess(details.name)});
        }catch{}
      }
      return json({items});
    }
    if(path==='/actions/result') {
      if(typeof body.id!=='string'||! /^[a-f0-9-]{36}$/.test(body.id))return json({error:'Action unavailable'},404);
      const receipt=await storage.get<ActionReceipt>('actions:result:'+body.id);
      if(receipt&&receipt.expires>now) {
        const details=await openRecord<{result?:unknown}>(this.env.JAN_PROXY_KEY,accountId,'action-result',receipt.sealed);
        if(receipt.parts!==undefined){
          if(!Number.isInteger(receipt.parts)||receipt.parts<1||receipt.parts>48)return json({error:'Image result unavailable'},503);
          try {
            let serialized='';
            for(let i=0;i<receipt.parts;i++){
              const part=await storage.get<{expires:number;sealed:SealedRecord}>('actions:result-part:'+body.id+':'+i);
              if(!part||part.expires<=now)throw Error('Image result expired');
              const {text}=await openRecord<{text:string}>(this.env.JAN_PROXY_KEY,accountId,'action-result-part:'+body.id+':'+i,part.sealed);
              if(typeof text!=='string'||text.length>16384)throw Error('Invalid result part');
              serialized+=text;
            }
            if(new TextEncoder().encode(serialized).length>786432)throw Error('Image result too large');
            details.result=JSON.parse(serialized);
          }catch{return json({error:'Image result unavailable or expired'},503);}
        }
        const status=receipt.status==='running'&&now>receipt.expires-570000?'unknown':receipt.status;
        return json({action_id:body.id,status,...(details.result?{result:details.result}:{})});
      }
      const item=(await storage.get<ActionApproval[]>('actions:v1')??[]).find(entry=>entry.id===body.id&&entry.expires>now);
      return item?json({action_id:body.id,status:item.status}):json({error:'Action unavailable or expired'},404);
    }
    if(path==='/actions/view'||path==='/actions/decide') {
      if(typeof body.id!=='string'||! /^[a-f0-9-]{36}$/.test(body.id))return json({error:'Action unavailable'},404);
      if(path==='/actions/view') {
        const item=(await storage.get<ActionApproval[]>('actions:v1')??[]).find(entry=>entry.id===body.id&&entry.expires>now);
        if(!item) {
          const receipt=await storage.get<ActionReceipt>('actions:result:'+body.id);
          if(!receipt||receipt.expires<=now)return json({error:'Action unavailable'},404);
          const details=await openRecord<{name:string;args:unknown;result?:unknown}>(this.env.JAN_PROXY_KEY,accountId,'action-result',receipt.sealed);
          const devices=await storage.get<Record<string,Entry>>('devices')??{};
          const status=receipt.status==='running'&&now>receipt.expires-570000?'unknown':receipt.status;
          return json({...details,args:reviewArgs(details.args),deviceName:devices[receipt.deviceId]?.name??'Computer',status,expires:receipt.expires,autoRun:true});
        }
        const devices=await storage.get<Record<string,Entry>>('devices')??{};
        if(devices[item.deviceId]?.revoked||await storage.get('active')!==item.deviceId)return json({error:'Selection changed'},409);
        try {
          const details=await openRecord<{name:string;args:unknown}>(this.env.JAN_PROXY_KEY,accountId,'action-approval',item.sealed);
          return json({name:details.name,args:reviewArgs(details.args),deviceName:devices[item.deviceId]?.name,status:item.status,expires:item.expires,autoRun:item.autoRun===true});
        } catch {return json({error:'Action unavailable'},404);}
      }
      if(body.decision!=='approve'&&body.decision!=='deny')return json({error:'Decision denied'},400);
      if(body.access!==undefined&&!['read','write'].includes(String(body.access)))return json({error:'Invalid access mode'},400);
      const decision=await storage.transaction(async tx=>{
        const items=await tx.get<ActionApproval[]>('actions:v1')??[];
        const item=items.find(entry=>entry.id===body.id&&entry.expires>now&&entry.status==='pending');
        const devices=await tx.get<Record<string,Entry>>('devices')??{};
        if(!item||devices[item.deviceId]?.revoked||await tx.get('active')!==item.deviceId)return json({error:'Action unavailable'},409);
        if(body.decision==='approve'&&body.access==='read') {
          const details=await openRecord<{name:string}>(this.env.JAN_PROXY_KEY,accountId,'action-approval',item.sealed);
          if(actionAccess(details.name)!=='read')return json({error:'Read-only approval cannot run a write or control action'},403);
        }
        if(item.autoRun&&body.decision==='approve') {
          const receipts=await tx.list<ActionReceipt>({prefix:'actions:result:',limit:65});
          let live=0;for(const [key,value] of receipts){if(value.expires<=now)await tx.delete(key);else live++;}
          if(live>=64)return json({error:'Too many recent actions. Wait for earlier results to expire.'},429);
        }
        item.status=body.decision==='approve'?'approved':'denied';
        if(item.autoRun&&body.decision==='approve')item.executionId=crypto.randomUUID();
        await tx.put('actions:v1',items);
        return {item};
      });
      if(decision instanceof Response)return decision;
      const item=decision.item;
      if(body.decision!=='approve'||!item.autoRun)return json({ok:true});
      // Reuse the original relay approval consumption and device checks, never a bypass path.
      const key='actions:result:'+item.id,expires=Date.now()+600000;
      const details=await openRecord<{name:string;args:unknown;meta?:unknown}>(this.env.JAN_PROXY_KEY,accountId,'action-approval',item.sealed);
      const queuedCall={jsonrpc:'2.0',id:item.id,method:'tools/call',params:{name:details.name,arguments:details.args,...(details.meta?{_meta:details.meta}:{})}};
      const receipt:ActionReceipt={deviceId:item.deviceId,expires,status:'running',sealed:await sealRecord(this.env.JAN_PROXY_KEY,accountId,'action-result',{name:details.name,args:details.args},expires)};
      await storage.put(key,receipt);
      let result:unknown={isError:true,content:[{type:'text',text:'Action outcome is unknown. Inspect the computer before starting a new action. Do not retry the mutation automatically.'}]};
      try {
        const response=await this.fetch(new Request('https://internal.invalid/relay/dispatch',{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':accountId,'X-Jan-Action-Execution':item.executionId!},body:JSON.stringify({type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify(queuedCall)})}));
        if(response.ok) {
          const reply=await response.json() as {payload:string};
          const rpc=JSON.parse(reply.payload) as {jsonrpc?:unknown;id?:unknown;result?:unknown;error?:{code?:unknown;data?:unknown}};
          if(rpc.result!==undefined){result=rpc.result;receipt.status='completed';}
          else if(rpc.jsonrpc==='2.0'&&rpc.id===item.id&&rpc.error?.code===-32001) {
            const data=rpc.error.data as Record<string,unknown>|undefined;
            if(data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).sort().join(',')==='automatic_retry,error_code,executed'&&data.error_code==='LOCAL_BUSY'&&data.executed===false&&data.automatic_retry===false) {
              result={isError:true,content:[{type:'text',text:'The local PCRC agent is busy. This request was not executed. Do not retry automatically.'}],structuredContent:{error_code:'LOCAL_BUSY',executed:false,automatic_retry:false}};
              receipt.status='completed';
            }
          }
        }
      } catch {}
      if(receipt.status==='running')receipt.status='unknown';
      const serialized=JSON.stringify(result),size=new TextEncoder().encode(serialized).length;
      const images=Array.isArray((result as any)?.content)&&(result as any).content.some((part:any)=>part?.type==='image');
      const parts:Array<{expires:number;sealed:SealedRecord}>=[];
      if(images&&size>32768&&size<=786432){
        // Chunk encrypted image receipts below the Durable Object per-value limit.
        for(let offset=0;offset<serialized.length;offset+=16384)parts.push({expires,sealed:await sealRecord(this.env.JAN_PROXY_KEY,accountId,'action-result-part:'+item.id+':'+parts.length,{text:serialized.slice(offset,offset+16384)},expires)});
        receipt.parts=parts.length;
        result={isError:(result as any)?.isError===true,content:[{type:'text',text:'Image result saved temporarily. The assistant can retrieve it using get_action_result.'}]};
      }else if(size>32768)result={isError:images||(result as {isError?:boolean})?.isError===true,content:[{type:'text',text:images?'Image result exceeds the 768 KiB image receipt limit. Request a smaller capture. Do not repeat a mutation to recover output.':'Action returned a result larger than the 32 KiB receipt limit. Inspect the computer or read the affected file; do not repeat the mutation to recover output.'}]};
      receipt.sealed=await sealRecord(this.env.JAN_PROXY_KEY,accountId,'action-result',{name:details.name,args:details.args,result},expires);
      await storage.transaction(async tx=>{
        const state=await deletionState(tx);
        if(!state.closing&&!state.deleted){
          for(let i=0;i<parts.length;i++)await tx.put('actions:result-part:'+item.id+':'+i,parts[i]);
          await tx.put(key,receipt);
        }
      });
      return json({ok:true,status:receipt.status});
    }
    if(path.startsWith('/directory/')) {
      if(accountId!==this.env.ALLOWED_GITHUB_ID||this.env.JAN_MULTI_USER_ENABLED!=='1')return json({error:'Directory denied'},403);
      const prefix='directory:account:';
      if(path==='/directory/maintenance-report') {
        const old=await storage.get<{lastRun:number;lastSuccess:number|null;checked:number;deleted:number;failures:number}>('maintenance:report:v1');
        if(body.read===true)return json(old??null);
        if(typeof body.success!=='boolean'||body.success&&(!Number.isInteger(body.checked)||Number(body.checked)<0||Number(body.checked)>5||!Number.isInteger(body.deleted)||Number(body.deleted)<0||Number(body.deleted)>Number(body.checked)))return json({error:'Invalid maintenance report'},400);
        await storage.put('maintenance:report:v1',{lastRun:now,lastSuccess:body.success?now:old?.lastSuccess??null,checked:body.success?body.checked:0,deleted:body.success?body.deleted:0,failures:body.success?0:(old?.failures??0)+1});
        return json({ok:true});
      }
      if(path==='/directory/register') {
        const id=authenticatedAccountId(body.id);
        if(!id||!permittedAccount(id,this.env.ALLOWED_GITHUB_ID,this.env.JAN_MULTI_USER_ENABLED,this.env.JAN_BETA_GITHUB_IDS))return json({error:'Account denied'},403);
        if(await storage.get('directory:deleted:'+id))return json({error:'Account deleted'},410);
        if(typeof body.login==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(body.login)){
          const login=body.login;
          await storage.transaction(async tx=>{
            const old=await tx.get<string>(prefix+id);
            const meta=await tx.get<MemberMeta>('owner:member:'+id)??{created:old===undefined?now:null,lastLogin:null,logins:[]};
            meta.lastLogin=now;meta.logins=[...meta.logins,now].slice(-10);await tx.put('owner:member:'+id,meta);
            await indexMember(tx,id,login,meta.created);

            if(typeof old==='string'&&old.toLowerCase()!==login.toLowerCase())await removeDirectoryAlias(tx,'directory:login:'+old.toLowerCase(),id);
            const key='directory:login:'+login.toLowerCase(),ids=[...new Set([...aliasIds(await tx.get<DirectoryAlias>(key)),id])];
            await tx.put(prefix+id,login);
            // Display names are not identities: a collision must never select a different account.
            await tx.put(key,ids.length===1?id:{ids});
          });
        } else await storage.transaction(async tx=>{const old=await tx.get<string|boolean>(prefix+id),meta=await tx.get<MemberMeta>('owner:member:'+id)??{created:old===undefined?now:null,lastLogin:null,logins:[]};await tx.put(prefix+id,old??true);await tx.put('owner:member:'+id,meta);await indexMember(tx,id,old??true,meta.created);});
        return json({ok:true});
      }
      if(path==='/directory/remove') {
        const id=authenticatedAccountId(body.id);
        if(!id||id===accountId)return json({error:'Account denied'},403);
        await storage.transaction(async tx=>{
          await tx.put('directory:deleted:'+id,{at:now});
          await removeMemberIndex(tx,id);
          const github=await tx.get<{id:string}>('github-link:v1:'+id);
          if(github){await tx.put('github-closed:v1:'+github.id,{at:now});await tx.delete('github-identity:v1:'+github.id);await tx.delete('github-link:v1:'+id);}
          if(!id.startsWith('s-'))await tx.delete('github-identity:v1:'+id);
          const subject=id.startsWith('s-')?id.slice(2):await tx.get<string>('email-link:v1:'+id);
          if(subject){
            await tx.put('email-closed:v1:'+subject,{at:now});
            const username=await tx.get<string>('email-username:v1:'+subject);
            if(username){const item=await tx.get<{record:SealedRecord}>('email-login:v1:'+username);if(item){const value=await openRecord<{email:string}>(this.env.JAN_PROXY_KEY,accountId,'email-login',item.record);await tx.delete('email-index:v1:'+await emailIndex(this.env.JAN_PROXY_KEY,value.email));}await tx.delete('email-login:v1:'+username);}
            await tx.delete('email-username:v1:'+subject);await tx.delete('email-identity:v1:'+subject);await tx.delete('email-link:v1:'+id);
          }
          const login=await tx.get<string>(prefix+id);
          if(typeof login==='string')await removeDirectoryAlias(tx,'directory:login:'+login.toLowerCase(),id);
          await tx.delete(prefix+id);
          const pairs=await tx.get<Record<string,{ownerId?:string}>>('pairing:v1');
          if(pairs)await tx.put('pairing:v1',Object.fromEntries(Object.entries(pairs).filter(([,p])=>p.ownerId!==id)));
        });
        return json({ok:true});
      }
      if(path==='/directory/find') {
        if(typeof body.query!=='string'||! /^(?:\d{1,20}|[A-Za-z0-9-]{1,100})$/.test(body.query))return json({error:'Invalid search'},400);
        const alias=await storage.get<DirectoryAlias>('directory:login:'+body.query.toLowerCase());
        const id=authenticatedAccountId(body.query)??(typeof alias==='string'?authenticatedAccountId(alias):null);
        return json({id:id&&await storage.get(prefix+id)?id:null,login:id?await storage.get(prefix+id):null,...(!id&&typeof alias==='object'?{ambiguous:true}:{})});
      }
      if(path==='/directory/list') {
        const after=body.after===undefined?null:authenticatedAccountId(body.after);
        if(body.after!==undefined&&!after)return json({error:'Invalid cursor'},400);
        if(await storage.get(prefix+accountId)===undefined)await storage.put(prefix+accountId,true);
        const items=await storage.list({prefix,limit:26,...(after?{startAfter:prefix+after}:{})});
        const ids=[...items.keys()].map(key=>key.slice(prefix.length));
        return json({ids:ids.slice(0,25),next:ids.length>25?ids[24]:null});
      }
      if(path==='/directory/maintenance') {
        const after=await storage.get<string>('directory:maintenance-cursor:v1');
        const items=await storage.list({prefix,limit:5,...(after?{startAfter:after}:{})});
        if(items.size===5)await storage.put('directory:maintenance-cursor:v1',[...items.keys()].at(-1)!);
        else await storage.delete('directory:maintenance-cursor:v1');
        return json({ids:[...items.keys()].map(key=>key.slice(prefix.length))});
      }
      return json({error:'Unknown directory operation'},404);
    }
    if(path.startsWith('/pairing/')) return pairingStore(path,body,storage,this.env,now);
    if(path==='/oauth/start') {
      const state=body.state,verifier=body.verifier;
      if(typeof state!=='string'||!/^janportal\.[A-Za-z0-9_-]{32,}$/.test(state)||typeof verifier!=='string'||verifier.length<43) return json({error:'Invalid state'},400);
      const returnTo=signInReturn(body.returnTo)??'/devices';
      const link=body.link as {accountId?:unknown;csrf?:unknown;authVersion?:unknown}|undefined;
      if(link&&(!authenticatedAccountId(link.accountId)||!String(link.accountId).startsWith('s-')||typeof link.csrf!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(link.csrf)||!Number.isSafeInteger(link.authVersion))){
        console.warn('PCRC_GITHUB_LINK_START_REJECTED',JSON.stringify({accountValid:!!authenticatedAccountId(link.accountId)&&String(link.accountId).startsWith('s-'),csrfValid:typeof link.csrf==='string'&&/^[A-Za-z0-9_-]{43}$/.test(link.csrf),versionValid:Number.isSafeInteger(link.authVersion)}));
        return json({error:'Link denied'},403);
      }
      const oauthRecord=await sealRecord(this.env.JAN_PROXY_KEY,accountId,'portal-oauth',{verifier,returnTo,...(link?{link}:{})},now+300000);
      if(this.env.JAN_MULTI_USER_ENABLED!=='1') {await storage.put('oauth:'+state,oauthRecord);return json({ok:true});}
      if(typeof body.clientKey!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(body.clientKey))return json({error:'Invalid client'},400);
      return storage.transaction(async tx=>{
        const pending=await tx.get<Record<string,{expires:number}>>('oauth:pending:v1')??{};
        for(const [key,item] of Object.entries(pending))if(item.expires<=now){delete pending[key];await tx.delete('oauth:'+key);}
        if(Object.keys(pending).length>=128)return json({error:'Sign-in capacity reached'},429);
        const rates=await tx.get<Record<string,{start:number;count:number}>>('oauth:client-rates:v1')??{};
        for(const [key,item] of Object.entries(rates))if(item.start+60000<=now)delete rates[key];
        const client=rates[body.clientKey as string]??{start:now,count:0};
        if(client.count>=5)return json({error:'Sign-in client limit reached'},429);
        client.count++;rates[body.clientKey as string]=client;
        await tx.put('oauth:client-rates:v1',rates);
        pending[state]={expires:now+300000};
        await tx.put('oauth:pending:v1',pending);
        await tx.put('oauth:'+state,oauthRecord);
        return json({ok:true});
      });
    }
    if(path==='/oauth/consume') {
      const key='oauth:'+body.state;
      return storage.transaction(async tx=>{
        const item=await tx.get<{verifier?:string;returnTo?:string;expires:number}&Partial<SealedRecord>>(key);
        if(!item || item.expires<now) {if(item)await tx.delete(key);return json({error:'Expired state'},403);}
        await tx.delete(key);
        if(this.env.JAN_MULTI_USER_ENABLED==='1') {
          const pending=await tx.get<Record<string,{expires:number}>>('oauth:pending:v1')??{};
          delete pending[String(body.state)];await tx.put('oauth:pending:v1',pending);
        }
        try {
          const details=item.v===1?await openRecord<{verifier:string;returnTo?:string;link?:unknown}>(this.env.JAN_PROXY_KEY,accountId,'portal-oauth',item as SealedRecord):item;
          return json({verifier:details.verifier,returnTo:details.returnTo??'/devices',...('link' in details&&details.link?{link:details.link}:{})});
        } catch {return json({error:'Invalid state'},403);}
      });
    }
    if(path.startsWith('/email-recovery/')) {
      if(typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)||!authenticatedAccountId('s-'+body.subject))return json({error:'Recovery denied'},403);
      if(path==='/email-recovery/create'){await storage.put('email-recovery:v1',{hash:body.hash,subject:body.subject,expires:now+300000,authVersion:await storage.get<number>('account:auth-version:v1')??0});return json({ok:true});}
      if(path==='/email-recovery/consume')return storage.transaction(async tx=>{
        const item=await tx.get<{hash:string;subject:string;expires:number;authVersion:number}>('email-recovery:v1'),version=await tx.get<number>('account:auth-version:v1')??0;
        if(!item||item.expires<=now||item.hash!==body.hash||item.subject!==body.subject||item.authVersion!==version)return json({error:'Recovery expired or used'},403);
        await tx.delete('email-recovery:v1');await tx.put('account:password-reset:v1',{started:now});await tx.put('account:auth-version:v1',version+1);await tx.put('actions:v1',[]);
        return json({authVersion:version+1});
      });
      return json({error:'Recovery denied'},404);
    }
    if(path==='/account/auth-version')return json({authVersion:await storage.get<number>('account:auth-version:v1')??0,resetting:!!await storage.get('account:password-reset:v1')});
    if(path==='/account/reset-finish')return storage.transaction(async tx=>{const version=await tx.get<number>('account:auth-version:v1')??0;if(body.authVersion!==version)return json({error:'Recovery changed'},409);await tx.put('account:auth-version:v1',version+1);await tx.delete('account:password-reset:v1');return json({ok:true});});
    if(path==='/account/reset-sessions') {
      const authVersion=await storage.transaction(async tx=>{const next=(await tx.get<number>('account:auth-version:v1')??0)+1;await tx.put('account:auth-version:v1',next);await tx.put('actions:v1',[]);return next;});
      return json({authVersion});
    }
    if(path==='/account/link-state'){
      const entries=await storage.list({limit:3});
      return json({inUse:[...entries.keys()].some(key=>!['account:owner:v1','health:v1'].includes(key))});
    }
    if(path.startsWith('/github-link/')){
      if(!accountId.startsWith('s-')||typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)||typeof body.csrf!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(body.csrf))return json({error:'Link denied'},403);
      const version=await storage.get<number>('account:auth-version:v1')??0;
      if(await storage.get('account:password-reset:v1')||body.authVersion!==version)return json({error:'Sign-in changed'},403);
      if(path==='/github-link/review'){
        if(!authenticatedGitHubId(body.githubId,body.githubId)||typeof body.login!=='string'||! /^[a-zA-Z0-9-]{1,39}$/.test(body.login))return json({error:'GitHub identity denied'},403);
        const record=await sealRecord(this.env.JAN_PROXY_KEY,accountId,'github-link-review',{githubId:body.githubId,login:body.login,csrf:body.csrf,authVersion:version},now+300000);
        await storage.put('github-link:pending:v1',{hash:body.hash,record,expires:record.expires});return json({ok:true});
      }
      if(path==='/github-link/consume')return storage.transaction(async tx=>{
        const pending=await tx.get<{hash:string;record:SealedRecord}>('github-link:pending:v1');
        if(!pending||pending.hash!==body.hash||pending.record.expires<=now)return json({error:'Link expired or used'},403);
        const details=await openRecord<{githubId:string;login:string;csrf:string;authVersion:number}>(this.env.JAN_PROXY_KEY,accountId,'github-link-review',pending.record);
        if(details.csrf!==body.csrf||details.authVersion!==(await tx.get<number>('account:auth-version:v1')??0)||await tx.get('account:password-reset:v1'))return json({error:'Sign-in changed'},403);
        await tx.delete('github-link:pending:v1');return json({githubId:details.githubId,login:details.login});
      });
      return json({error:'Link denied'},404);
    }
    if(path.startsWith('/github-identity/')){
      if(accountId!==this.env.ALLOWED_GITHUB_ID||this.env.JAN_MULTI_USER_ENABLED!=='1')return json({error:'Identity denied'},403);
      if(path==='/github-identity/status'){
        const target=authenticatedAccountId(body.accountId);
        if(!target||!target.startsWith('s-'))return json({error:'Identity denied'},403);
        const linked=await storage.get<{id:string;login:string}>('github-link:v1:'+target);
        return json(linked?{linked:true,login:linked.login}:{linked:false});
      }
      const githubId=authenticatedGitHubId(body.githubId,body.githubId);
      if(!githubId)return json({error:'Identity denied'},403);
      return storage.transaction(async tx=>{
        if(await tx.get('github-closed:v1:'+githubId)||await tx.get('directory:deleted:'+githubId))return json({error:'Account closed'},410);
        const key='github-identity:v1:'+githubId,existing=await tx.get<string>(key);
        if(path==='/github-identity/resolve'){
          const id=existing??githubId;
          if(!authenticatedAccountId(id)||await tx.get('directory:deleted:'+id)||id.startsWith('s-')&&await tx.get('email-closed:v1:'+id.slice(2)))return json({error:'Account closed'},410);
          // Reserve normal GitHub sign-in atomically, so a concurrent link cannot merge it.
          if(!existing)await tx.put(key,id);
          return json({id});
        }
        if(path!=='/github-identity/link')return json({error:'Identity denied'},404);
        const target=authenticatedAccountId(body.accountId);
        if(!target||!target.startsWith('s-')||githubId===this.env.ALLOWED_GITHUB_ID||typeof body.login!=='string'||! /^[a-zA-Z0-9-]{1,39}$/.test(body.login))return json({error:'Link denied'},403);
        if(await tx.get('directory:deleted:'+target)||await tx.get('email-closed:v1:'+target.slice(2)))return json({error:'Account closed'},410);
        if(!await tx.get('directory:account:'+target)||existing&&existing!==target||await tx.get('directory:account:'+githubId))return json({error:'GitHub already belongs to another PCRC account'},409);
        const reverse='github-link:v1:'+target,previous=await tx.get<{id:string}>(reverse);
        if(previous&&previous.id!==githubId)return json({error:'GitHub already linked'},409);
        await tx.put(key,target);await tx.put(reverse,{id:githubId,login:body.login});return json({id:target});
      });
    }
    if(path.startsWith('/email-identity/')) {
      if(path==='/email-identity/available'){if(accountId!==this.env.ALLOWED_GITHUB_ID||!validEmailUsername(body.username))return json({error:'Username denied'},400);return json({available:!await storage.get('email-login:v1:'+body.username)});}
      if(path==='/email-identity/lookup-email') {
        if(accountId!==this.env.ALLOWED_GITHUB_ID||typeof body.email!=='string'||body.email.length>254)return json({error:'Identity denied'},403);
        return json({id:await storage.get<string>('email-index:v1:'+await emailIndex(this.env.JAN_PROXY_KEY,body.email))??null});
      }
      if(path==='/email-identity/lookup') {
        if(accountId!==this.env.ALLOWED_GITHUB_ID||typeof body.username!=='string'||! /^[a-z0-9][a-z0-9_-]{2,36}$/.test(body.username))return json({error:'Identity denied'},403);
        const value=await storage.get<{subject:string;record:SealedRecord}>('email-login:v1:'+body.username);
        if(!value)return json({email:null});
        return json(await openRecord<{email:string}>(this.env.JAN_PROXY_KEY,accountId,'email-login',value.record));
      }
      if(accountId!==this.env.ALLOWED_GITHUB_ID||typeof body.subject!=='string'||!authenticatedAccountId('s-'+body.subject))return json({error:'Identity denied'},403);
      const key='email-identity:v1:'+body.subject;
      if(await storage.get('email-closed:v1:'+body.subject))return json({error:'Account closed'},410);
      if(path==='/email-identity/resolve') {
        if(typeof body.email!=='string'||body.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))return json({error:'Identity email denied'},400);
        const address=body.email;
        const result=await storage.transaction(async tx=>{
          if(await tx.get('email-closed:v1:'+body.subject))throw Error('Account closed');
          let id=await tx.get<string>(key);if(!id){id='s-'+body.subject;await tx.put(key,id);}
          if(await tx.get('directory:deleted:'+id))throw Error('Account closed');
          const reverse='email-username:v1:'+body.subject;
          let username=await tx.get<string>(reverse);
          if(!username){
            const proposed=validEmailUsername(body.username)?body.username:'pcrc-'+String(body.subject).replaceAll('-','');
            const occupied=await tx.get<{subject:string}>('email-login:v1:'+proposed);
            username=occupied&&occupied.subject!==body.subject?'pcrc-'+String(body.subject).replaceAll('-',''):proposed;
            await tx.put(reverse,username);
          }
          const previous=await tx.get<{record:SealedRecord}>('email-login:v1:'+username);
          if(previous){const value=await openRecord<{email:string}>(this.env.JAN_PROXY_KEY,accountId,'email-login',previous.record);if(value.email!==address)await tx.delete('email-index:v1:'+await emailIndex(this.env.JAN_PROXY_KEY,value.email));}
          await tx.put('email-index:v1:'+await emailIndex(this.env.JAN_PROXY_KEY,address),id);
          const record=await sealRecord(this.env.JAN_PROXY_KEY,accountId,'email-login',{email:address},Number.MAX_SAFE_INTEGER);
          await tx.put('email-login:v1:'+username,{subject:body.subject,record});
          return {id,username};
        });
        return json(result);
      }
      if(path==='/email-identity/link') {
        const target=authenticatedAccountId(body.accountId);
        if(!target||target.startsWith('s-')||await storage.get('directory:deleted:'+target))return json({error:'Link denied'},403);
        return storage.transaction(async tx=>{if(await tx.get('email-closed:v1:'+body.subject)||await tx.get('directory:deleted:'+target))return json({error:'Account closed'},410);const existing=await tx.get<string>(key);if(existing&&existing!==target)return json({error:'Email already belongs to another PCRC account'},409);const reverse='email-link:v1:'+target;const previous=await tx.get<string>(reverse);if(previous&&previous!==body.subject)return json({error:'An email is already linked'},409);await tx.put(key,target);await tx.put(reverse,body.subject);return json({id:target});});
      }
      return json({error:'Identity operation denied'},404);
    }
    if(path==='/session/create') {
      const version=await storage.get<number>('account:auth-version:v1')??0;
      if(await storage.get('account:password-reset:v1')||body.expectedAuthVersion!==undefined&&body.expectedAuthVersion!==version)return json({error:'Sign-in changed; retry'},409);
      if(typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)||typeof body.login!=='string'||body.login.length>100||typeof body.csrf!=='string') return json({error:'Invalid session'},400);
      if(body.userId!==undefined&&body.userId!==accountId)return json({error:'Account denied'},403);
      const sessionRecord=await sealRecord(this.env.JAN_PROXY_KEY,accountId,'portal-session',{login:body.login,csrf:body.csrf,userId:accountId,...(typeof body.ownerOrigin==='string'&&typeof body.ownerLoginAt==='number'?{ownerOrigin:body.ownerOrigin,ownerLoginAt:body.ownerLoginAt,...(authenticatedGitHubId(body.ownerGithubId,body.ownerGithubId)?{ownerGithubId:body.ownerGithubId}:{})}:{}),authVersion:await storage.get<number>('account:auth-version:v1')??0},now+86400000);
      if(this.env.JAN_MULTI_USER_ENABLED!=='1') {await storage.put('session:'+body.hash,sessionRecord);return json({ok:true});}
      return storage.transaction(async tx=>{
        if(await tx.get('account:closing:v1')||await tx.get('account:deleted:v1'))return json({error:'Account access closed'},410);
        const sessions=await tx.get<Record<string,{expires:number}>>('session:index:v1')??{};
        for(const [hash,item] of Object.entries(sessions))if(item.expires<=now){delete sessions[hash];await tx.delete('session:'+hash);}
        if(Object.keys(sessions).length>=32) {
          const oldest=Object.entries(sessions).sort((a,b)=>a[1].expires-b[1].expires)[0][0];
          delete sessions[oldest];await tx.delete('session:'+oldest);
        }
        sessions[body.hash as string]={expires:now+86400000};
        await tx.put('session:index:v1',sessions);
        await tx.put('session:'+body.hash,sessionRecord);
        return json({ok:true});
      });
    }
    if(path==='/session/get') {
      if(typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)) return json({error:'Invalid session'},400);
      const item=await storage.get<{login?:string;csrf?:string;expires:number}&Partial<SealedRecord>>('session:'+body.hash);
      if(item&&item.expires<=now)await storage.delete('session:'+body.hash);
      if(!item||item.expires<=now||await storage.get('account:password-reset:v1'))return json(null);
      try {
        const details=item.v===1?await openRecord<{login:string;csrf:string;userId:string;authVersion?:number}>(this.env.JAN_PROXY_KEY,accountId,'portal-session',item as SealedRecord):item;
        if('userId' in details&&details.userId!==accountId)return json(null);
        if((('authVersion' in details?details.authVersion:0)??0)!==(await storage.get<number>('account:auth-version:v1')??0))return json(null);
        return json({...details,expires:item.expires,...(lifecycle.closing?{closing:true}:{})});
      } catch {return json(null);}
    }
    if(path==='/session/delete') {
      if(typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)) return json({error:'Invalid session'},400);
      await storage.delete('session:'+body.hash);
      if(this.env.JAN_MULTI_USER_ENABLED==='1')await storage.transaction(async tx=>{
        const sessions=await tx.get<Record<string,{expires:number}>>('session:index:v1')??{};
        delete sessions[String(body.hash)];await tx.put('session:index:v1',sessions);
      });
      return json({ok:true});
    }
    if(path==='/device/reconnect-check') {
      const device=(await storage.get<Record<string,Entry>>('devices')??{})[String(body.id)];
      return device?.ownerId===accountId&&device.publicKey===body.publicKey?json({ok:true,accountReleased:device.accountReleased===true}):json({error:'Saved installation does not match this account'},403);
    }
    if(path==='/device/release')return storage.transaction(async tx=>{
      const devices=await tx.get<Record<string,Entry>>('devices')??{},device=devices[String(body.id)];
      if(!device||typeof device.publicKey!=='string')return json({error:'Unknown computer'},404);
      const ids=Object.values(devices).filter(record=>record.publicKey===device.publicKey).map(record=>String(record.id));
      for(const record of Object.values(devices))if(record.publicKey===device.publicKey){record.revoked=true;record.revokedAt=now;record.accountReleased=true;this.relay.disconnect(String(record.id));if(await tx.get('active')===record.id)await tx.delete('active');}
      await tx.put('device:key-release:v1:'+device.publicKey,now);
      await tx.put('devices',devices);await tx.delete('actions:v1');
      return json({publicKey:device.publicKey,ownerId:accountId,ids});
    });
    if(path==='/device/enrollment-check') {
      const {pro,revision,validUntil}=await this.planState();
      const others=Object.values(await storage.get<Record<string,Entry>>('devices')??{}).filter(d=>!d.revoked&&d.publicKey!==body.publicKey).length;
      return json({pro,revision,validUntil,allowed:pro||others<1});
    }
    if(path==='/device/import'&&this.env.JAN_MULTI_USER_ENABLED==='1') {
      const capabilities=body.capabilities;
      const allowed=['browser','commands','desktop','files'];
      const validCapabilities=Array.isArray(capabilities)&&capabilities.length>=1&&capabilities.length<=6&&capabilities[0]==='read'&&
        (capabilities.length===1||capabilities[1]==='control'&&capabilities.length>=3&&
          capabilities.slice(2).every((item:unknown)=>typeof item==='string'&&allowed.includes(item))&&new Set(capabilities.slice(2)).size===capabilities.length-2&&
          JSON.stringify(capabilities.slice(2))===JSON.stringify(capabilities.slice(2).sort()));
      if(body.ownerId!==accountId||typeof body.id!=='string'||! /^[a-f0-9-]{36}$/.test(body.id)||typeof body.publicKey!=='string'||! /^[A-Za-z0-9_-]{120,128}$/.test(body.publicKey)||typeof body.name!=='string'||! /^[\w .-]{1,64}$/.test(body.name)||typeof body.login!=='string'||body.login.length>100||!validCapabilities)return json({error:'Device import denied'},403);
      return storage.transaction(async tx=>{
        const devices=await tx.get<Record<string,Entry>>('devices')??{};
        const released=await tx.get<number>('device:key-release:v1:'+body.publicKey);
        if(released!==undefined&&(typeof body.approvedAt!=='number'||body.approvedAt<=released))return json({error:'This approval predates the owner release. Start a fresh request.'},403);
        const previous=devices[String(body.id)];
        if(previous)return previous.ownerId===accountId&&previous.publicKey===body.publicKey&&!previous.revoked?json({ok:true}):json({error:'Device import denied'},403);
        if(Object.values(devices).filter(d=>!d.revoked&&d.publicKey!==body.publicKey).length>=1&&!await this.effectivePro(tx,true))return json({error:'Free accounts support one active computer'},429);
        for(const device of Object.values(devices))if(!device.revoked&&device.publicKey===body.publicKey){device.revoked=true;device.revokedAt=now;this.relay.disconnect(String(device.id));if(await tx.get('active')===device.id)await tx.put('active',body.id);}
        devices[String(body.id)]={id:body.id,name:body.name,os:body.os,agentVersion:body.agentVersion,ownerId:accountId,login:body.login,publicKey:body.publicKey,capabilities:body.capabilities,created:now,revoked:false,lastSeen:0,origin:null};
        await tx.put('devices',devices);return json({ok:true});
      });
    }
    if(path==='/pair/create') {
      if(typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)) return json({error:'Invalid code'},400);
      await storage.put('pair:'+body.hash,{login:body.login,expires:now+300000});
      return json({ok:true});
    }
    if(path==='/pair/claim') {
      if(typeof body.hash!=='string'||! /^[a-f0-9]{64}$/.test(body.hash)||typeof body.name!=='string'||! /^.{1,64}$/.test(body.name)||typeof body.id!=='string'||! /^[a-f0-9-]{36}$/.test(body.id)) return json({error:'Invalid claim'},400);
      return storage.transaction(async tx=>{
        const key='pair:'+body.hash;
        const item=await tx.get<{login:string;expires:number}>(key);
        if(!item||item.expires<now) return json({error:'Code invalid or expired'},403);
        await tx.delete(key);
        const devices=await tx.get<Record<string,Entry>>('devices')??{};
        if(Object.values(devices).filter(d=>!d.revoked).length>=12&&!await this.effectivePro(tx,true)) return json({error:'Device limit reached'},429);
        const id=body.id as string;
        devices[id]={id,name:body.name,login:item.login,created:now,revoked:false,lastSeen:0,origin:null};
        await tx.put('devices',devices);
        return json({id:body.id,name:body.name,login:item.login,active:(await tx.get('active'))===body.id});
      });
    }
    if(path==='/device/register') {
      return storage.transaction(async tx=>{
        const devices=await tx.get<Record<string,Entry>>('devices')??{};
        const device=devices[String(body.id)];
        if(!device||device.revoked) return json({error:'Device denied'},403);
        const timestamp=body.timestamp;
        if(typeof timestamp!=='number'||!Number.isSafeInteger(timestamp)||timestamp<=Number(device.lastSeen)||Math.abs(Math.floor(now/1000)-timestamp)>60) return json({error:'Registration expired'},403);
        device.origin=body.origin;device.lastSeen=timestamp;devices[String(body.id)]=device;
        await tx.put('devices',devices);
        // Preserve the previous, already-running legacy origin until a newly
        // paired device has proved its public tunnel and signed registration.
        if(!await tx.get('activated')) {
          await tx.put('active',body.id);
          await tx.put('activated',true);
        }
        return json({active:(await tx.get('active'))===body.id});
      });
    }
    if(path==='/device/active') {
      const active=await storage.get<string>('active');
      const devices=await storage.get<Record<string,Entry>>('devices')??{};
      const device=active?devices[active]:undefined;
      return json({enrolled:!!await storage.get('activated'),device:device&&!device.revoked&&Number(device.lastSeen)>Math.floor(now/1000)-180?{id:device.id,origin:device.origin}:null});
    }
    if(path==='/device/status-summary') {
      const devices=await storage.get<Record<string,Entry>>('devices')??{};
      const sessions=await storage.get<Record<string,{expires:number}>>('session:index:v1')??{};
      return json({activeBrowserSessions:Object.values(sessions).filter(session=>session.expires>now).length,recordedToolCalls:await storage.get<number>('calls')??0,plan:await this.effectivePro(storage)?'pro':'free',complimentary:(await storage.get<{until:number}>('billing:complimentary:v1'))?.until!>now,devices:Object.values(devices).filter(device=>!device.revoked).map(device=>({
        name:device.name,
        online:device.publicKey?this.relay.getSession(String(device.id))?.online===true:null,
      }))});
    }
    if(path==='/device/list') {
      const active=await storage.get('active');
      const devices=await storage.get<Record<string,Entry>>('devices')??{};
      const calls=await storage.get<number>('calls')??0;
      const usage=await storage.get<Usage>('usage:daily:v1')??null;
      const activity=await storage.get<Activity[]>('activity:recent:v1')??[];
      const subscriptions=await storage.get<Subscriptions>('billing:subscriptions:v1')??null;
      return json({active,devices:Object.values(devices).map(({id,name,login,created,revoked,lastSeen,os,agentVersion,capabilities,publicKey,calls})=>({id,name,login,created,revoked,lastSeen,os,agentVersion,capabilities,calls:Number(calls)||0,...(publicKey?{online:this.relay.getSession(String(id))?.online===true}:{})})),calls,usage,monthly:monthlyUsage(usage,now),plan:await this.effectivePro(storage)?'pro':'free',billing:Object.values(subscriptions??{}).map(({id,status,cancelAt})=>({id,status,cancelAt:cancelAt??null})),activity:activity.slice(-20).reverse(),measuredAt:now});
    }
    if(path==='/device/revoke-all') {
      return storage.transaction(async tx=>{
        const devices=await tx.get<Record<string,Entry>>('devices')??{};
        for(const device of Object.values(devices)){device.revoked=true;device.revokedAt=now;this.relay.disconnect(String(device.id));}
        await tx.put('devices',devices);await tx.delete('active');await tx.delete('actions:v1');return json({ok:true});
      });
    }
    if(path==='/device/rename') {
      if(typeof body.name!=='string'||! /^[\w .-]{1,64}$/.test(body.name)) return json({error:'Invalid device name'},400);
      return storage.transaction(async tx=>{
        const devices=await tx.get<Record<string,Entry>>('devices')??{},device=devices[String(body.id)];
        if(!device||device.revoked) return json({error:'Unknown device'},404);
        device.name=body.name;await tx.put('devices',devices);return json({ok:true});
      });
    }
    if(path==='/device/unselect') {
      return storage.transaction(async tx=>{
        if(await tx.get('active')!==body.id) return json({error:'Selection changed'},409);
        await tx.delete('active');await tx.delete('actions:v1');
        return json({ok:true});
      });
    }
    if(path==='/device/select'||path==='/device/revoke') {
      return storage.transaction(async tx=>{
        const devices=await tx.get<Record<string,Entry>>('devices')??{};
        const device=devices[String(body.id)];
        if(!device||device.revoked) return json({error:'Unknown device'},404);
        if(path==='/device/revoke') {device.revoked=true;device.revokedAt=now;devices[String(body.id)]=device;await tx.put('devices',devices);if(await tx.get('active')===body.id)await tx.delete('active');this.relay.disconnect(String(body.id));}
        else {await tx.put('active',body.id);await tx.put('activated',true);}
        await tx.delete('actions:v1');
        return json({ok:true});
      });
    }
    if(path==='/usage/increment') {
      return storage.transaction(async tx=>{
        if(await tx.get('account:closing:v1')||await tx.get('account:deleted:v1'))return json({error:'Account access closed'},410);
        const usage=await tx.get<Usage>('usage:daily:v1')??{started:now,days:{}};
        const month=monthlyUsage(usage,now);
        if(month.used>=month.limit&&!await this.effectivePro(tx,true))return json({error:'Monthly tool-call limit reached',resetsAt:month.resetsAt},429);
        const window=await tx.get<{started:number;count:number}>('usage:minute:v1')??{started:now,count:0};
        if(now-window.started>=60000){window.started=now;window.count=0;}
        if(window.count>=120)return json({error:'Account tool-call rate limit reached'},429);
        window.count++;
        await tx.put('usage:minute:v1',window);
        const total=(await tx.get<number>('calls')??0)+1;
        await tx.put('calls',total);
        const day=new Date(now).toISOString().slice(0,10);
        usage.days[day]=(usage.days[day]??0)+1;
        const oldest=new Date(now-186*86400000).toISOString().slice(0,10);
        for(const key of Object.keys(usage.days)) if(key<oldest)delete usage.days[key];
        await tx.put('usage:daily:v1',usage);
        return json({calls:total});
      });
    }
    return json({error:'Not found'},404);
  }
}
