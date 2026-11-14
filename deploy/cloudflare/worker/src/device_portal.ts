import {emailAuth,emailAuthEnabled} from './email_auth.ts';
import {approvalInbox} from './approval_inbox.ts';
import type {PendingAction} from './action_access.ts';
import {requiresActionReview,actionPurpose} from './action_access.ts';
import {dashboardReturn,signInReturn} from './portal_return.ts';
import {websitePromptManager,type WebsitePrompt,type PromptCategory} from './website_prompts.ts';
import type {OAuthHelpers} from '@cloudflare/workers-oauth-provider';
import {config,escaped,failure,deviceKey,boundedBody,type Settings} from './policy.ts';
import {s256} from './authorization.ts';
import {permittedAccount,validBetaIds} from './account_identity.ts';
import {portalPage,deviceDashboard,connectPage,assistantPage,usagePage,verificationPage,adminDashboard,subscriptionManager,signInLanding,pageHeading,icon,button,hidden,type PortalData,type PortalOwner} from './portal_ui.ts';
import {checkoutBinding,billingReady,liveBilling,billingApiReady,paddleSubscription,refundableTransaction,cancelPaddleSubscription,refundPaddleTransaction} from './billing.ts';
import {loadBillingHistory,billingHistoryPage,billingMonth,currentPayment} from './billing_history.ts';
function connectionCheckPage(owner:PortalOwner,result:{checks:{step:string;status:string;help:string}[];toolCount:number|null;computer:string|null;assistantOAuth:string}) {
  return portalPage(pageHeading('Connection check','Find the failed step before reconnecting.')+'<section class="panel"><div class="panel-body">'+(result.computer?'<p>Computer: <strong>'+escaped(result.computer)+'</strong></p>':'')+result.checks.map(check=>'<div class="setting"><div><strong>'+escaped(check.step)+'</strong>'+(check.status==='pass'?'':'<p>'+escaped(check.help)+'</p>')+'</div><span class="badge '+(check.status==='pass'?'online':'')+'">'+escaped(check.status)+'</span></div>').join('')+(result.toolCount!==null?'<p>'+result.toolCount+' tools discovered through your device relay.</p>':'')+'<p class="footnote">'+escaped(result.assistantOAuth)+'</p><form method="post" action="/devices/connection-check">'+hidden('csrf',owner.csrf)+button('Check live tool discovery')+'</form><p><a href="/devices">Back to dashboard</a></p></div></section>','Connection check',{owner});
}
export interface DeviceEnv extends Settings {DEVICES:DurableObjectNamespace;OAUTH_PROVIDER?:OAuthHelpers;}
export const randomCode=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
class AccountAccessDenied extends Error {}
export class DeviceStateError extends Error {status:number;constructor(status:number) {super('Private device state rejected');this.status=status;}}
export async function digest(value:string):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
}
export async function deviceStore(env:DeviceEnv,path:string,data:unknown,accountId=env.ALLOWED_GITHUB_ID):Promise<any> {
  if(!permittedAccount(accountId,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS)) throw new DeviceStateError(403);
  const stub=env.DEVICES.get(env.DEVICES.idFromName(accountId));
  const response=await stub.fetch('https://internal.invalid'+path,{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json','X-Jan-Account-Id':accountId}});
  if(!response.ok) throw new DeviceStateError(response.status);
  return response.json();
}
async function pairingAccount(env:DeviceEnv,id:string,accountId:string,approving=false) {
  const context=await deviceStore(env,'/pairing/context',{id}) as {publicKey:string;owners:string[];accountChoice:boolean};
  const target=await deviceStore(env,'/device/enrollment-check',{publicKey:context.publicKey},accountId);
  await deviceStore(env,'/pairing/plan',{ownerId:accountId,pro:target.pro,revision:target.revision});
  let shareAllowed=false;
  if(context.accountChoice&&target.pro){
    shareAllowed=true;
    for(const other of context.owners){
      const state=await deviceStore(env,'/device/enrollment-check',{publicKey:context.publicKey},other);
      await deviceStore(env,'/pairing/plan',{ownerId:other,pro:state.pro,revision:state.revision});
      if(!state.pro){shareAllowed=false;break;}
    }
  }
  if(approving&&!target.allowed)throw new DeviceStateError(429);
  return {shareAllowed,shareOwners:context.owners,pro:target.pro};
}
function html(body:string,status=200,headers:Record<string,string>={}) {
  return portalPage('<section class="panel center-card"><div class="panel-body">'+body+'</div></section>','Device setup',{status,headers});
}
function cookie(request:Request) {return /(?:^|;\s*)__Host-JanPortal=([A-Za-z0-9_.-]{40,140})(?:;|$)/.exec(request.headers.get('Cookie')??'')?.[1];}
async function portalCookie(request:Request,env:DeviceEnv):Promise<{accountId:string;token:string}|null> {
  const value=cookie(request);
  if(!value)return null;
  if(!value.includes('.'))return {accountId:env.ALLOWED_GITHUB_ID,token:value}; // Existing owner sessions.
  const parts=value.split('.');
  if(parts.length!==3||!permittedAccount(parts[0],env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS)||!/^[A-Za-z0-9_-]{43}$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))return null;
  const expected=await sessionMac(env,parts[0],parts[1]);
  let difference=0;for(let i=0;i<43;i++)difference|=expected.charCodeAt(i)^parts[2].charCodeAt(i);
  return difference?null:{accountId:parts[0],token:parts[1]};
}
async function sessionMac(env:DeviceEnv,accountId:string,token:string):Promise<string> {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.JAN_PROXY_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('JAN_PORTAL_SESSION_V2\n'+accountId+'\n'+token)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function pairingClientKey(request:Request,env:DeviceEnv):Promise<string> {
  const source=request.headers.get('CF-Connecting-IP');
  const ip=source&&source.length<=64?source:'unknown';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.JAN_PROXY_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('JAN_PAIR_CLIENT_V1\n'+ip)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function session(request:Request,env:DeviceEnv,allowClosing=false) {
  const selected=await portalCookie(request,env);
  if(!selected) return null;
  let item:{login:string;csrf:string;userId?:string;closing?:boolean;authVersion?:number}|null;
  try {item=await deviceStore(env,'/session/get',{hash:await digest(selected.token)},selected.accountId);}
  catch(error){if(error instanceof DeviceStateError&&error.status===410)return null;throw error;}
  if(item?.closing&&!allowClosing)return null;
  return item&&(item.userId===selected.accountId||selected.accountId===env.ALLOWED_GITHUB_ID&&item.userId===undefined)?{...item,userId:selected.accountId}:null;
}
export async function createPortalSession(env:DeviceEnv,identity:{id:string;login:string},returnTo='/devices',expectedAuthVersion?:number):Promise<Response> {
  const token=randomCode(),csrf=randomCode();
  if(env.JAN_MULTI_USER_ENABLED==='1')await deviceStore(env,'/directory/register',{id:identity.id,login:identity.login},env.ALLOWED_GITHUB_ID);
  await deviceStore(env,'/session/create',{hash:await digest(token),login:identity.login,csrf,userId:identity.id,...(expectedAuthVersion!==undefined?{expectedAuthVersion}:{})},identity.id);
  const initial=env.JAN_SITE_ROLE!=='owner'&&returnTo==='/devices'&&env.JAN_PAIRING_ENABLED==='1'&&!(await deviceStore(env,'/device/list',{},identity.id)).devices.some((d:{revoked:boolean})=>!d.revoked);
  const value=env.JAN_MULTI_USER_ENABLED==='1'?identity.id+'.'+token+'.'+await sessionMac(env,identity.id,token):token;
  return new Response(null,{status:302,headers:{Location:config(env).publicOrigin+(env.JAN_SITE_ROLE==='owner'?'/admin':initial?'/devices/connect':signInReturn(returnTo)??'/devices'),'Set-Cookie':'__Host-JanPortal='+value+'; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
function accountPrivacyPage(owner:PortalOwner,notice='',status=200) {
  return portalPage(pageHeading('Account & privacy','Review what deleting your account removes.')+(notice?'<div class="notice" role="alert">'+escaped(notice)+'</div>':'')+'<section class="panel"><div class="panel-body"><h2>Delete your PCRC account</h2><p>This disconnects your computers, revokes assistant access, and removes PCRC sessions, device records, usage, activity and account-directory details. It cannot undo commands already accepted by a computer.</p><p>Cancel all subscriptions first and wait for cancellation to take effect. Deletion does not issue a refund, delete your GitHub or Paddle account, erase their legally retained records, or remove local files, backups, keys, and installed software from your computers.</p><p>A minimal account-ID closure marker remains to block old tokens, late billing events, and accidental re-creation. This permanently closes this PCRC account; contact support before trying to join again.</p><p>Processing can continue in the background if a provider is unavailable. No other account is affected.</p><form novalidate data-mutation method="post" action="/devices/account/delete">'+hidden('csrf',owner.csrf)+'<label for="delete-confirm">Type DELETE to confirm</label><input id="delete-confirm" name="confirmation" autocomplete="off" required><div class="action-row"><a class="button neutral" href="/devices">Keep my account</a>'+button('Delete my account','danger')+'</div></form></div></section>','Account & privacy',{owner,active:'account',status});
}
export async function completeAccountDeletion(env:DeviceEnv,id:string):Promise<boolean> {
  const state=await deviceStore(env,'/account/deletion-state',{},id) as {closing:boolean;deleted:boolean};
  if(!state.closing&&!state.deleted)return false;
  if(!env.OAUTH_PROVIDER)throw Error('Account cleanup unavailable');
  const grants=await env.OAUTH_PROVIDER.listUserGrants(id,{limit:5});
  for(const grant of grants.items) {
    if(grant.userId!==id)throw Error('Account cleanup denied');
    await env.OAUTH_PROVIDER.revokeGrant(grant.id,id);
  }
  const remaining=await env.OAUTH_PROVIDER.listUserGrants(id,{limit:1});
  if(remaining.items.length||remaining.cursor)return false;
  const result=await deviceStore(env,'/account/delete-finish',{},id) as {ok:boolean};
  if(!result.ok)return false;
  await deviceStore(env,'/directory/remove',{id});
  return true;
}
export async function maintainAccounts(env:DeviceEnv):Promise<{checked:number;deleted:number}> {
  const page=await deviceStore(env,'/directory/maintenance',{}) as {ids:string[]};
  let deleted=0;
  for(const id of page.ids) {
    await deviceStore(env,'/account/retention',{},id);
    const state=await deviceStore(env,'/account/deletion-state',{},id) as {closing:boolean;deleted:boolean};
    if((state.closing||state.deleted)&&await completeAccountDeletion(env,id))deleted++;
  }
  return {checked:page.ids.length,deleted};
}
export async function resolveGitHubAccount(env:DeviceEnv,githubId:string):Promise<string>{
  if(env.JAN_SITE_ROLE!=='public'||env.JAN_MULTI_USER_ENABLED!=='1')return githubId;
  const result=await deviceStore(env,'/github-identity/resolve',{githubId});
  if(!permittedAccount(result.id,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS))throw new AccountAccessDenied();
  return result.id;
}
async function githubSessionBinding(csrf:string):Promise<string>{
  if(csrf.length<16||csrf.length>128)throw new DeviceStateError(403);
  // Keep exact legacy form-CSRF checks; use a fixed-size digest only for internal link binding.
  return s256('PCRC_GITHUB_LINK_SESSION_V1\n'+csrf);
}
async function beginGitHubLogin(request:Request,env:DeviceEnv,returnTo:string,link?:{accountId:string;csrf:string;authVersion:number}):Promise<Response>{
  const state='janportal.'+randomCode(),verifier=randomCode()+randomCode(),origin=config(env).publicOrigin;
  await deviceStore(env,'/oauth/start',{state,verifier,returnTo,...(link?{link}:{}),...(env.JAN_MULTI_USER_ENABLED==='1'?{clientKey:await pairingClientKey(request,env)}:{})});
  const target=new URL('https://github.com/login/oauth/authorize');
  target.search=new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:origin+'/callback',scope:'read:user',state,code_challenge:await s256(verifier),code_challenge_method:'S256'}).toString();
  return new Response(null,{status:302,headers:{Location:target.href,'Set-Cookie':'__Host-JanPortalOAuth='+state+'; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
async function githubIdentity(code:string,verifier:string,env:DeviceEnv,fetcher:typeof fetch) {
  const origin=config(env).publicOrigin;
  const response=await fetcher('https://github.com/login/oauth/access_token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,redirect_uri:origin+'/callback',code,code_verifier:verifier})});
  if(!response.ok) throw Error('Provider failed');
  const token=(await response.json() as {access_token?:string}).access_token;
  if(typeof token!=='string'||token.length>4096) throw Error('Provider failed');
  const user=await fetcher('https://api.github.com/user',{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'JAN-MCP-Commander','X-GitHub-Api-Version':'2022-11-28'}});
  if(!user.ok) throw Error('Provider failed');
  const identity=await user.json() as {id?:number;login?:string};
  if(!Number.isSafeInteger(identity.id)||typeof identity.login!=='string')throw Error('Provider failed');
  if(!permittedAccount(String(identity.id),env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS))throw new AccountAccessDenied();
  return {id:String(identity.id),login:identity.login.slice(0,100)};
}
function revokePage(data:PortalData,owner:PortalOwner,id:string|null) {
  const device=id?data.devices.find(d=>d.id===id&&!d.revoked):null;
  if(id&&!device)return failure(404,'Computer unavailable');
  const title=id?'Revoke '+device!.name+'?':'Revoke all computers?';
  return portalPage('<a class="back-link" href="/devices">'+icon('back')+'Back to devices</a>'+pageHeading(title,'Review this change before continuing.')+'<section class="panel center-card"><div class="panel-body"><h2>'+(id?escaped(device!.name):data.devices.filter(d=>!d.revoked).length+' computers')+'</h2><p class="subtitle">'+(id?'This computer':'All your computers')+' will disconnect immediately. Saved credentials will stop working. Reconnecting requires a fresh matching-code approval.</p><p class="footnote">This does not delete files from your computer.</p><form novalidate data-mutation method="post" action="'+(id?'/devices/revoke':'/devices/revoke-all')+'">'+hidden('csrf',owner.csrf)+hidden('confirmation','revoke')+(id?hidden('id',id):'')+'<div class="action-row"><a class="button neutral" href="/devices" autofocus>Keep '+(id?'computer':'computers')+'</a>'+button(id?'Revoke access':'Revoke all access','danger')+'</div></form></div></section>','Confirm revocation',{owner,data});
}
export async function portal(request:Request,env:DeviceEnv,fetcher:typeof fetch=fetch):Promise<Response> {
  const settings=config(env),url=new URL(request.url),path=url.pathname;
  if(url.origin!==settings.publicOrigin) return failure(403,'Origin denied');
  if(request.method==='GET'&&['/devices/actions','/devices/approve'].includes(path)) {
    let cleaned=false;
    for(const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid']) {
      if(url.searchParams.has(key)){url.searchParams.delete(key);cleaned=true;}
    }
    if(cleaned)return new Response(null,{status:302,headers:{Location:settings.publicOrigin+path+url.search,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  if(request.method==='GET'&&(path==='/devices'||path==='/devices/')&&(path.endsWith('/')||url.search&&!/^\?notice=(selected|disconnected|revoked|approved|renamed|revoked-all|pro)$/.test(url.search))) {
    return new Response(null,{status:302,headers:{Location:settings.publicOrigin+'/devices','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  try {
    const emailResponse=await emailAuth(request,env,fetcher);if(emailResponse)return emailResponse;
    if(path==='/'&&request.method==='GET')return new Response(null,{status:303,headers:{Location:settings.publicOrigin+(env.JAN_SITE_ROLE==='owner'?'/admin':'/devices'),'Cache-Control':'no-store'}});
    if(path==='/support'&&request.method==='GET'&&!url.search&&env.JAN_SITE_ROLE!=='owner')return portalPage(
      pageHeading('Support','Get help with sign-in, pairing, and your connection.')+
      '<section class="panel"><div class="panel-body"><h2>Setup help</h2><p>For installation and pairing instructions, open <a href="/devices/connect">Add a computer</a>. For ChatGPT, Claude, and other MCP clients, read the <a href="/devices/assistant">assistant setup guide</a>. Sign-in is required to open these guides.</p><h2>Contact</h2><p>Email <a href="mailto:pcremotecommander@gmail.com">pcremotecommander@gmail.com</a> with the issue and the steps that led to it. Do not email passwords, pairing codes, device keys, file contents, or screenshots containing private data.</p><p class="footnote">This is the official support contact for PC Remote Commander. Include whether your computer appears online, but do not send its private credentials.</p></div></section>',
      'Support',{publicSiteMenu:true}
    );
    if(path==='/support')return failure(404,'Unavailable');
    if(env.JAN_SITE_ROLE!=='owner'&&request.method==='GET'&&['/devices/sign-in','/devices/login'].includes(path)&&url.searchParams.has('return')) {
      const target=signInReturn(url.searchParams.get('return'));
      if(!target||[...url.searchParams.keys()].length!==1)return failure(400,'Invalid sign-in destination');
    }
    if(path==='/devices/sign-in'&&env.JAN_SITE_ROLE!=='owner'&&request.method==='GET') {
      const target=signInReturn(url.searchParams.get('return'))??'/devices';
      if(await session(request,env))return new Response(null,{status:303,headers:{Location:settings.publicOrigin+target,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
      return signInLanding('/devices/login?'+new URLSearchParams({return:target}));
    }
    if((path==='/devices/login'&&env.JAN_SITE_ROLE!=='owner'||path==='/owner/login'&&env.JAN_SITE_ROLE==='owner')&&request.method==='GET'&&(!url.search||path==='/devices/login'&&(/^\?(?:pair|consent)=[A-Za-z0-9_-]{43}$/.test(url.search)||/^\?action=[a-f0-9-]{36}$/.test(url.search)||/^\?checkout=txn_[a-z0-9]{26}$/.test(url.search)||signInReturn(url.searchParams.get('return'))!==null))) {
      return await beginGitHubLogin(request,env,env.JAN_SITE_ROLE==='owner'?'/admin':signInReturn(url.searchParams.get('return'))??(url.searchParams.has('consent')?'/consent?handle='+url.searchParams.get('consent'):url.searchParams.has('action')?'/devices/actions?id='+url.searchParams.get('action'):url.searchParams.has('checkout')?'/devices/plan?_ptxn='+url.searchParams.get('checkout'):url.search?'/devices/approve?id='+url.searchParams.get('pair'):'/devices'));
    }
    if(path==='/callback'&&request.method==='GET'&&url.searchParams.get('state')?.startsWith('janportal.')) {
      const state=url.searchParams.get('state'),code=url.searchParams.get('code');
      if(!state||!code||code.length>512) return failure(400,'Sign-in failed');
      const bound=/(?:^|;\s*)__Host-JanPortalOAuth=(janportal\.[A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('Cookie')??'')?.[1];
      if(bound!==state) return failure(403,'Sign-in browser binding denied');
      const {verifier,returnTo,link}=await deviceStore(env,'/oauth/consume',{state}) as {verifier:string;returnTo:string;link?:{accountId:string;csrf:string;authVersion:number}};
      const identity=await githubIdentity(code,verifier,env,fetcher);
      if(env.JAN_SITE_ROLE==='owner'&&identity.id!==env.ALLOWED_GITHUB_ID)return failure(403,'Owner account required');
      if(link){
        const current=await session(request,env);
        if(!emailAuthEnabled(env)||!current||current.userId!==link.accountId||await githubSessionBinding(current.csrf)!==link.csrf||(current.authVersion??0)!==link.authVersion)return failure(403,'The PCRC session changed. Start linking GitHub again from Settings.');
        const token=randomCode();
        await deviceStore(env,'/github-link/review',{hash:await digest(token),githubId:identity.id,login:identity.login,csrf:await githubSessionBinding(current.csrf),authVersion:current.authVersion??0},current.userId);
        return portalPage(pageHeading('Connect GitHub','Review the GitHub identity before linking it to your current PCRC account.')+'<section class="panel center-card"><div class="panel-body"><h2>@'+escaped(identity.login)+'</h2><p>Connect this GitHub account to <strong>'+escaped(current.login)+'</strong>? Your computers and subscription stay on your current PCRC account. Existing separate accounts will not be merged.</p><form method="post" action="/devices/github/confirm">'+hidden('csrf',current.csrf)+hidden('token',token)+'<div class="action-row">'+button('Confirm GitHub connection','primary')+'<a class="button neutral" href="/devices/settings">Cancel</a></div></form></div></section>','Review GitHub connection',{owner:current,active:'settings',headers:{'Referrer-Policy':'same-origin','Set-Cookie':'__Host-JanPortalOAuth=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}});
      }
      const canonical=await resolveGitHubAccount(env,identity.id);
      const linked=canonical!==identity.id?await deviceStore(env,'/directory/find',{query:canonical}):null;
      const response=await createPortalSession(env,{id:canonical,login:typeof linked?.login==='string'?linked.login:identity.login},returnTo);
      response.headers.append('Set-Cookie','__Host-JanPortalOAuth=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return response;
    }
    if(path==='/devices/pair/start'||path==='/devices/pair/proof') {
      if(env.JAN_PAIRING_ENABLED!=='1') return failure(404,'Pairing preview disabled');
      if(request.method!=='POST'||url.search) return failure(405,'Method denied');
      // This is a native agent API. Browser mutations must use the authenticated CSRF-protected form.
      if(request.headers.has('Origin')) return failure(403,'Agent origin denied');
      if(request.headers.get('content-type')?.split(';')[0]!=='application/json') return failure(415,'JSON required');
      let value:unknown;
      try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await boundedBody(request,2048)));} catch {return failure(400,'Invalid pairing request');}
      if(!value||typeof value!=='object'||Array.isArray(value)) return failure(400,'Invalid pairing request');
      let submitted:any=value;
      if(path.endsWith('/start')){
        const input=value as Record<string,unknown>;
        if(Object.keys(input).some(key=>!['name','os','agentVersion','publicKey','capabilities','browserChoice','reconnect','accountChoice'].includes(key)))return failure(400,'Invalid pairing metadata');
        const {reconnect,...metadata}=input;
        let reconnectOwnerId,accountReleased=false;
        if(reconnect!==undefined){
          const old=reconnect as {id?:unknown;ownerId?:unknown};
          if(!old||typeof old!=='object'||Object.keys(old).sort().join(',')!=='id,ownerId'||typeof old.id!=='string'||! /^[a-f0-9-]{36}$/.test(old.id)||!permittedAccount(old.ownerId,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS))return failure(400,'Invalid saved account');
          reconnectOwnerId=String(old.ownerId);
          const released=await deviceStore(env,'/pairing/release-check',{id:old.id,publicKey:input.publicKey,ownerId:reconnectOwnerId});
          if(released.released===true){accountReleased=true;reconnectOwnerId=undefined;}
          else if(released.bound!==true)await deviceStore(env,'/device/reconnect-check',{id:old.id,publicKey:input.publicKey},reconnectOwnerId);
        }
        submitted={...metadata,...(reconnectOwnerId?{reconnectOwnerId}:{}),...(accountReleased?{accountReleased:true}:{}),...(env.JAN_MULTI_USER_ENABLED==='1'?{clientKey:await pairingClientKey(request,env)}:{})};
      }
      const data=await deviceStore(env,path.replace('/devices/pair/','/pairing/'),submitted);
      if(data.registration) {
        const registration=data.registration as {ownerId?:unknown;id?:unknown};
        const target=permittedAccount(registration.ownerId,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS);
        if(!target||data.session?.owner_id!==target)return failure(403,'Pairing denied');
        await deviceStore(env,'/device/import',registration,target);
        if(data.selectForAi===true)await deviceStore(env,'/device/select',{id:registration.id},target);
        delete data.registration;
      }
      return Response.json(data,{status:path.endsWith('/start')?201:200,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path==='/devices/claim'&&request.method==='POST'&&url.search==='') {
      if(env.JAN_MULTI_USER_ENABLED==='1')return failure(404,'Use matching-code pairing');
      if(request.headers.get('content-type')?.split(';')[0]!=='application/json') return failure(415,'JSON required');
      const value=await request.json() as {code?:string;name?:string};
      if(typeof value.code!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(value.code)||typeof value.name!=='string'||! /^[\w .-]{1,64}$/.test(value.name)) return failure(400,'Invalid enrollment');
      const id=crypto.randomUUID();
      const result=await deviceStore(env,'/pair/claim',{hash:await digest(value.code),name:value.name,id});
      return Response.json({...result,owner_id:env.ALLOWED_GITHUB_ID,key:await deviceKey(env.JAN_PROXY_KEY,id)},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path==='/library/prompts') {
      if(env.JAN_SITE_ROLE!=='public'||request.method!=='GET'||url.search)return failure(404,'Unavailable');
      const items=await deviceStore(env,'/website-prompts/list',{},env.ALLOWED_GITHUB_ID) as WebsitePrompt[];
      const categories=await deviceStore(env,'/website-prompts/categories',{},env.ALLOWED_GITHUB_ID) as PromptCategory[];
      return Response.json({prompts:items.filter(p=>p.published&&!p.deleted),categories},{headers:{'Cache-Control':'public, max-age=30','X-Content-Type-Options':'nosniff'}});
    }
    const owner=await session(request,env,path==='/devices/account'||path==='/devices/account/delete');
    const accountId=owner?permittedAccount(owner.userId??env.ALLOWED_GITHUB_ID,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS):null;
    if(owner&&!accountId)return failure(403,'Account denied');
    if(request.method==='POST'&&['/devices/github/link','/devices/github/confirm'].includes(path)){
      if(!emailAuthEnabled(env)||!owner||!accountId?.startsWith('s-'))return failure(403,'Sign in to your email/password PCRC account before connecting GitHub.');
      if(url.search||request.headers.get('Origin')!==settings.publicOrigin||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return failure(403,'Form origin denied');
      const form=new URLSearchParams(new TextDecoder().decode(await boundedBody(request,2048)));
      if(form.get('csrf')!==owner.csrf)return failure(403,'Form verification failed');
      if(path==='/devices/github/link'){
        const started=await beginGitHubLogin(request,env,'/devices/settings',{accountId,csrf:await githubSessionBinding(owner.csrf),authVersion:owner.authVersion??0});
        const destination=started.headers.get('Location')!;
        // Finish the POST here; a direct cross-origin form redirect is blocked by form-action 'self'.
        return portalPage('<section class="panel center-card"><div class="panel-body"><h1>Continue to GitHub</h1><p>Sign in to the GitHub account you want to connect. You will review it before linking.</p><a class="button primary" href="'+escaped(destination)+'">Continue to GitHub</a></div></section>','Connect GitHub',{headers:{Refresh:'0; url='+destination,'Set-Cookie':started.headers.get('Set-Cookie')!,'Referrer-Policy':'no-referrer'}});
      }
      const token=form.get('token');if(!token||! /^[A-Za-z0-9_-]{43}$/.test(token))return failure(403,'GitHub review expired. Start again from Settings.');
      const verified=await deviceStore(env,'/github-link/consume',{hash:await digest(token),csrf:await githubSessionBinding(owner.csrf),authVersion:owner.authVersion??0},accountId) as {githubId:string;login:string};
      const existing=await deviceStore(env,'/account/link-state',{},verified.githubId) as {inUse:boolean};
      if(existing.inUse)return html('<h1>GitHub is already used by another PCRC account</h1><p>No accounts were merged. Return to Settings and choose a different GitHub account.</p><a href="/devices/settings">Back to Settings</a>',409);
      await deviceStore(env,'/github-identity/link',{githubId:verified.githubId,login:verified.login,accountId});
      return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices/settings','Cache-Control':'no-store'}});
    }
    const returnPage=dashboardReturn(path+url.search);
    if(!owner&&env.JAN_SITE_ROLE!=='owner'&&request.method==='GET'&&path!=='/devices'&&returnPage) {
      return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices/sign-in?'+new URLSearchParams({return:returnPage}),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
    const ownerStore=(storePath:string,data:unknown)=>deviceStore(env,storePath,data,accountId!);
    if(path==='/admin/accounts'){
      if(env.JAN_SITE_ROLE!=='owner')return failure(404,'Unavailable');
      if(!owner||accountId!==env.ALLOWED_GITHUB_ID)return failure(403,'Owner sign-in required');
      let form:URLSearchParams|null=null;
      if(request.method==='POST'){
        if(url.search||request.headers.get('Origin')!==settings.publicOrigin||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return failure(403,'Form denied');
        form=new URLSearchParams(new TextDecoder().decode(await boundedBody(request,2048)));
        if(form.get('csrf')!==owner.csrf)return failure(403,'Form denied');
      }else if(request.method!=='GET'||[...url.searchParams.keys()].some(key=>key!=='account'))return failure(400,'Invalid account request');
      const query=form?.get('account')??url.searchParams.get('account')??'';
      const found=query?await ownerStore('/directory/find',{query}):null;
      const target=found?.id;
      if(query&&!target)return html('<h1>Account not found</h1><p>Search by an exact account ID. No account was changed.</p><a href="/admin/accounts">Try again</a>',404);
      if(form){
        const operation=form.get('operation');
        if(!target||operation==='delete'&&target===env.ALLOWED_GITHUB_ID)return failure(403,'Operator account cannot be deleted here');
        if(!['revoke','release','delete'].includes(String(operation))||form.get('confirmation')!==String(operation).toUpperCase())return failure(400,'Type the matching confirmation word. No account was changed.');
        if(operation==='delete'){
          await deviceStore(env,'/account/delete-start',{confirmation:'DELETE'},target);
          return portalPage(pageHeading('Account deletion started','Device access is blocked. Background cleanup will revoke assistant grants and remove active account data.')+'<a class="button neutral" href="/admin/accounts">Back to accounts</a>','Account deletion started',{owner,ownerSite:true,active:'accounts',status:202});
        }
        const device=form.get('device');
        if(typeof device!=='string'||! /^[a-f0-9-]{36}$/.test(device))return failure(400,'Choose the exact computer');
        if(operation==='release'){
          const released=await deviceStore(env,'/device/release',{id:device},target);
          await ownerStore('/pairing/release',released);
        }else await deviceStore(env,'/device/revoke',{id:device},target);
      }
      const data=target?await deviceStore(env,'/device/list',{},target) as PortalData:null;
      const confirm=(operation:string,label:string,device='')=>'<form method="post" action="/admin/accounts">'+hidden('csrf',owner.csrf)+hidden('account',target)+hidden('device',device)+hidden('operation',operation)+'<label>Type '+operation.toUpperCase()+'<input name="confirmation" autocomplete="off" required></label>'+button(label,'danger')+'</form>';
      return portalPage(pageHeading('User accounts','Review the exact account and computer before changing access.')+'<section class="panel"><div class="panel-body"><form method="get" action="/admin/accounts"><label>Account ID or username<input name="account" value="'+escaped(query)+'" required></label>'+button('Find account')+'</form></div></section>'+(target?'<section class="panel"><div class="panel-body"><h2>'+escaped(found.login)+' · '+escaped(target)+'</h2><p>Revoke blocks access while keeping the original account binding. Release for another account also unlocks this installation for a fresh matching-code approval. Neither action moves files or subscriptions.</p>'+data!.devices.map(d=>'<details><summary>'+escaped(d.name)+' · '+(d.revoked?'Revoked':'Active')+'</summary><p>Device ID: <code>'+escaped(d.id)+'</code></p>'+(!d.revoked?confirm('revoke','Revoke computer',d.id):'')+confirm('release','Release for another account',d.id)+'</details>').join('')+(target!==env.ALLOWED_GITHUB_ID?'<details><summary>Delete account</summary><p>Permanent closure. Cancel subscriptions first. Release the computer first if it needs to move to another account. A minimal closure marker remains.</p>'+confirm('delete','Start account deletion')+'</details>':'')+'</div></section>':'') ,'User accounts',{owner,ownerSite:true,active:'accounts'});
    }
    if(path==='/devices/account'||path==='/devices/account/delete') {
      if(env.JAN_SITE_ROLE!=='public'||url.search)return failure(404,'Unavailable');
      if(!owner)return signInLanding();
      if(accountId===env.ALLOWED_GITHUB_ID)return failure(403,'The operator account manages shared service data. Contact support for operator-account changes.');
      if(path==='/devices/account'&&request.method==='GET') {
        return accountPrivacyPage(owner);
      }
      if(path!=='/devices/account/delete'||request.method!=='POST')return failure(405,'Method denied');
      if(request.headers.get('Origin')!==settings.publicOrigin||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return failure(403,'Form denied');
      const raw=await request.text();if(raw.length>512)return failure(413,'Form too large');
      const form=new URLSearchParams(raw);
      if([...form.keys()].sort().join(',')!=='confirmation,csrf')return failure(400,'Invalid deletion form');
      if(form.get('csrf')!==owner.csrf)return failure(403,'Form denied');
      if(form.get('confirmation')!=='DELETE')return accountPrivacyPage(owner,'Type DELETE exactly to confirm. No deletion was started.',400);
      if(!env.OAUTH_PROVIDER)return failure(503,'Account cleanup unavailable. No deletion was started; try again shortly.');
      try {
        await ownerStore('/account/delete-start',{confirmation:'DELETE'});
        const done=await completeAccountDeletion(env,accountId!);
        if(!done)return html('<h1>Account deletion is processing</h1><p>Computer access is blocked. Background cleanup will continue. You can retry from <a href="/devices/account">Account & privacy</a> if your session is still available.</p>',202);
        return portalPage(pageHeading('Account deleted','Your PCRC account data has been removed from the active service.')+'<p>Device and assistant access is blocked. The minimal closure marker remains. GitHub, Paddle, provider retention, and files on your computer are separate.</p><a class="button neutral" href="/">Return home</a>','Account deleted',{headers:{'Set-Cookie':'__Host-JanPortal=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}});
      } catch(error) {
        if(error instanceof DeviceStateError&&error.status===409)return html('<h1>Cancel subscriptions first</h1><p>All subscriptions must be fully canceled before deletion. Open <a href="/devices/plan">Plan & billing</a> or contact support. No deletion was started.</p>',409);
        return html('<h1>Account cleanup is temporarily unavailable</h1><p>If deletion started, computer access remains blocked. Background cleanup will retry. You can return to <a href="/devices/account">Account & privacy</a> to retry.</p>',503);
      }
    }
    if(path==='/devices/billing/history'&&env.JAN_SITE_ROLE==='public'&&request.method==='GET') {
      if(!owner)return signInLanding();
      if(url.search&&!/^\?after=txn_[a-z0-9]{26}$/.test(url.search))return failure(400,'Invalid billing cursor');
      const data=await ownerStore('/device/list',{}) as PortalData;
      let history=null;try {history=await loadBillingHistory(env,accountId!,url.searchParams.get('after'));} catch {}
      return billingHistoryPage(history,owner,data);
    }
    if(path==='/owner/logout'&&env.JAN_SITE_ROLE==='owner'&&request.method==='POST') {
      if(!owner||accountId!==env.ALLOWED_GITHUB_ID||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return failure(403,'Form denied');
      const form=await request.formData();
      if(form.get('csrf')!==owner.csrf)return failure(403,'Form denied');
      const selected=await portalCookie(request,env);
      if(!selected||selected.accountId!==accountId)return failure(403,'Session denied');
      await ownerStore('/session/delete',{hash:await digest(selected.token)});
      return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/admin','Set-Cookie':'__Host-JanPortal=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0','Cache-Control':'no-store'}});
    }
    if(path==='/admin'&&request.method==='GET'&&(!url.search||/^\?after=[1-9][0-9]{0,19}$/.test(url.search))) {
      if(env.JAN_SITE_ROLE==='owner'&&!owner)return portalPage(pageHeading('Operator sign-in','Service monitoring for the PC Remote Commander operator only.')+'<section class="panel center-card"><div class="panel-body"><a class="button primary" href="/owner/login">Owner sign-in with GitHub</a></div></section>','Operator sign-in');
      if(!owner||accountId!==env.ALLOWED_GITHUB_ID)return failure(403,'Owner account required');
      if(env.JAN_MULTI_USER_ENABLED!=='1')return failure(404,'Operations unavailable');
      const beta=validBetaIds(env.JAN_BETA_GITHUB_IDS,env.ALLOWED_GITHUB_ID);
      if(beta&&url.search)return failure(400,'Invalid page');
      const directory=beta?{ids:env.JAN_BETA_GITHUB_IDS!.split(','),next:null}:await deviceStore(env,'/directory/list',{...(url.search?{after:url.searchParams.get('after')}: {})},env.ALLOWED_GITHUB_ID) as {ids:string[];next:string|null};
      const accounts:{id:string;status:{activeBrowserSessions:number;recordedToolCalls:number;plan?:'free'|'pro';devices:{name:string;online:boolean|null}[]}}[]=[];
      for(let i=0;i<directory.ids.length;i+=5) {
        accounts.push(...await Promise.all(directory.ids.slice(i,i+5).map(async id=>({id,status:await deviceStore(env,'/device/status-summary',{},id) as {activeBrowserSessions:number;recordedToolCalls:number;plan?:'free'|'pro';devices:{name:string;online:boolean|null}[]}}))));
      }
      return adminDashboard(accounts,owner,{beta,next:directory.next,ownerSite:env.JAN_SITE_ROLE==='owner',liveBilling:liveBilling(env),maintenance:await ownerStore('/directory/maintenance-report',{read:true})});
    }
    if(path==='/admin/prompts') {
      if(env.JAN_SITE_ROLE!=='owner'||!owner||accountId!==env.ALLOWED_GITHUB_ID)return failure(403,'Owner account required');
      if(request.method==='GET'&&(!url.search||url.search==='?saved=1'||/^\?edit=[a-f0-9-]{36}$/.test(url.search)))return websitePromptManager(owner,await ownerStore('/website-prompts/list',{}),await ownerStore('/website-prompts/categories',{}),url.search==='?saved=1',url.searchParams.get('edit'));
      if(request.method!=='POST'||url.search)return failure(405,'Method denied');
      if(request.headers.get('Origin')!==settings.publicOrigin||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return failure(403,'Form denied');
      const raw=await request.text();
      if(new TextEncoder().encode(raw).length>20000)return failure(413,'Prompt too large');
      const form=new URLSearchParams(raw);
      if(form.get('csrf')!==owner.csrf)return failure(403,'Form denied');
      if(form.get('action')==='save')await ownerStore('/website-prompts/save',{id:form.get('id'),title:form.get('title'),description:form.get('description'),category:form.get('category'),prompt:form.get('prompt'),published:form.get('published')==='yes'});
      else if(form.get('action')==='visibility'&&['yes','no'].includes(form.get('published')??''))await ownerStore('/website-prompts/visibility',{id:form.get('id'),published:form.get('published')==='yes'});
      else if(form.get('action')==='category-add')await ownerStore('/website-prompts/category-add',{id:form.get('id'),name:form.get('name')});
      else if(['delete','restore'].includes(form.get('action')??''))await ownerStore('/website-prompts/'+form.get('action'),{id:form.get('id')});
      else return failure(400,'Invalid prompt action');
      return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/admin/prompts?saved=1','Cache-Control':'no-store'}});
    }
    if(path==='/admin/subscriptions'&&env.JAN_SITE_ROLE==='owner') {
      if(!owner||accountId!==env.ALLOWED_GITHUB_ID)return failure(403,'Owner account required');
      const keyReady=billingApiReady(env);
      if(request.method==='GET') {
        const query=url.searchParams.get('q')??'';
        if(query&&!/^(?:\d{1,20}|[A-Za-z0-9-]{1,100})$/.test(query))return failure(400,'Search by account ID or GitHub username');
        let found=query?await ownerStore('/directory/find',{query}):null;
        let lookupError=found?.ambiguous?'More than one account uses this display name. Search by the exact PCRC account ID shown in the user dashboard.':'';
        if(query&&!/^\d+$/.test(query)&&!found?.id&&!found?.ambiguous) {
          try {
            const response=await fetcher('https://api.github.com/users/'+encodeURIComponent(query),{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Accept:'application/vnd.github+json','User-Agent':'PC-Remote-Commander',Authorization:'Basic '+btoa(env.GITHUB_CLIENT_ID+':'+env.GITHUB_CLIENT_SECRET)}});
            if(!response.ok&&response.status!==404)lookupError='GitHub username lookup is unavailable. Search by numeric account ID or try again.';
            if(response.ok) {
              const github=await response.json() as {id?:number;login?:string};
              if(typeof github.id==='number'&&Number.isSafeInteger(github.id)&&github.id>0&&typeof github.login==='string'&&github.login.toLowerCase()===query.toLowerCase()) {
                const existing=await ownerStore('/directory/find',{query:String(github.id)});
                if(existing.id===String(github.id)) {
                  found={id:existing.id,login:github.login};
                  await ownerStore('/directory/register',{id:existing.id,login:github.login});
                }
              }
            }
          } catch {if(!found?.id)lookupError='GitHub username lookup is unavailable. Search by numeric account ID or try again.';}
        }
        const id=found?.id as string|null;
        const subscriptions=id?await deviceStore(env,'/billing/summary',{},id) as {id:string;status:string;priceId:string;cancelAt:string|null}[]:[];
        const rows=[] as {id:string;status:string;priceId:string;cancelAt:string|null;refundTransaction?:string|null;verified?:boolean}[];
        for(const item of subscriptions.slice(0,20)) {
          let verified=false,refundTransaction:string|null=null;
          if(keyReady&&item.priceId===env.PADDLE_PRICE_ID)try {
            const paddle=await paddleSubscription(env,item.id,fetcher);
            verified=paddle.custom_data?.account_id===id;
            if(verified&&['active','canceled'].includes(paddle.status))refundTransaction=await refundableTransaction(env,item.id,fetcher);
            item.status=paddle.status;
            item.cancelAt=paddle.scheduled_change?.action==='cancel'?paddle.scheduled_change.effective_at:null;
          } catch(error) {lookupError=error instanceof Error?error.message:'Paddle lookup unavailable';}
          rows.push({...item,verified,refundTransaction});
        }
        const notice=url.searchParams.get('notice');
        return subscriptionManager(owner,query,id?{id,login:found.login,subscriptions:rows}:null,keyReady,lookupError|| (notice==='canceled'?'Subscription cancellation was sent to Paddle. The user dashboard will show the updated status.':notice==='refunded'?'Paddle received the full refund request. Its approval may take several minutes.':null),liveBilling(env));
      }
      if(request.method==='POST'&&!url.search) {
        if(!keyReady)return failure(503,'The selected Paddle billing API key is not configured on the owner Worker');
        if(request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return failure(403,'Form denied');
        const form=await request.formData(),id=form.get('id'),target=form.get('account'),action=form.get('action');
        if(form.get('csrf')!==owner.csrf||form.get('confirm')!=='yes'||typeof id!=='string'||!/^sub_[a-z0-9]{26}$/.test(id)||typeof target!=='string'||!/^\d{1,20}$/.test(target)||!['cancel','cancel_refund','refund'].includes(String(action)))return failure(403,'Billing action denied');
        const found=await ownerStore('/directory/find',{query:target});
        if(found.id!==target)return failure(404,'Account unavailable');
        const stored=await deviceStore(env,'/billing/summary',{},target) as {id:string;priceId:string}[];
        if(!stored.some(item=>item.id===id&&item.priceId===env.PADDLE_PRICE_ID))return failure(403,'Subscription does not belong to this account');
        const paddle=await paddleSubscription(env,id,fetcher);
        if(paddle.custom_data?.account_id!==target)return failure(403,'Paddle account binding differs');
        if(action==='cancel'&&(paddle.status!=='active'||paddle.scheduled_change))return failure(409,'Subscription is already changing');
        if(action==='cancel_refund'&&paddle.status!=='active'||action==='refund'&&paddle.status!=='canceled')return failure(409,'Subscription status changed');
        let transaction:string|null=null;
        if(action!=='cancel') {
          transaction=await refundableTransaction(env,id,fetcher);
          if(!transaction)return failure(409,'No eligible completed transaction for full refund');
          await deviceStore(env,'/billing/refund-lock',{id,transaction},target);
        }
        if(action!=='refund') {
          const updated=await cancelPaddleSubscription(env,id,action==='cancel_refund',fetcher);
          await deviceStore(env,'/billing/admin-state',{id,status:updated.status,cancelAt:updated.scheduled_change?.action==='cancel'?updated.scheduled_change.effective_at:null},target);
        }
        if(transaction) {
          const refund=await refundPaddleTransaction(env,transaction,'Owner-approved subscription cancellation',fetcher);
          console.log('PCRC_REFUND_REQUESTED',JSON.stringify({environment:env.PADDLE_ENVIRONMENT??'sandbox',status:refund.status}));
        }
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/admin/subscriptions?q='+target+'&notice='+(transaction?'refunded':'canceled'),'Cache-Control':'no-store'}});
      }
      return failure(405,'Method denied');
    }
    if(path==='/devices/approve'&&request.method==='GET') {
      if(env.JAN_PAIRING_ENABLED!=='1') return failure(404,'Pairing preview disabled');
      if(!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('id')??'')||[...url.searchParams.keys()].some(key=>!['id','step','client','os'].includes(key)||url.searchParams.getAll(key).length!==1)||url.searchParams.has('step')&&!['copy','run','assistant','verify'].includes(url.searchParams.get('step')!)||url.searchParams.has('client')&&!['chatgpt','claude','cursor'].includes(url.searchParams.get('client')!)||url.searchParams.has('os')&&!['windows','linux','macos'].includes(url.searchParams.get('os')!)) return html('<h1>Open a fresh connection link</h1><p>This verification link is incomplete or invalid. Open the full link printed by PCRC setup. If it expired, run setup again.</p><a href="/devices/connect">Add a computer</a>',400);
      const id=url.searchParams.get('id')!;
      if(!owner) return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices/sign-in?'+new URLSearchParams({return:'/devices/approve?id='+id}),'Cache-Control':'no-store'}});
      const access=await pairingAccount(env,id,accountId!);
      const pair=await deviceStore(env,'/pairing/view',{id,ownerId:accountId,...access});
      if(env.JAN_SITE_ROLE==='public')return connectPage(settings.publicOrigin,owner,undefined,url.searchParams.get('step')??'verify',true,(url.searchParams.get('os')??(/^linux/i.test(String(pair.os))?'linux':/^(darwin|mac)/i.test(String(pair.os))?'macos':'windows')) as 'windows'|'linux'|'macos',url.searchParams.get('client')==='claude'?'claude':url.searchParams.get('client')==='cursor'?'cursor':'chatgpt',{...pair,requireCode:env.JAN_MULTI_USER_ENABLED==='1'&&!pair.browserChoice});
      return verificationPage(pair,owner,env.JAN_MULTI_USER_ENABLED==='1');
    }
    if(path==='/devices/state'&&request.method==='GET'&&!url.search) {
      if(!owner)return failure(401,'Sign in required');
      return Response.json(await ownerStore('/device/list',{}),{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path==='/devices/connection-check'&&request.method==='GET'&&!url.search) {
      if(!owner)return signInLanding();
      return connectionCheckPage(owner,await ownerStore('/connection/check',{}));
    }
    if(path==='/devices/approvals'&&request.method==='GET'&&(!url.search||url.search==='?format=json')) {
      if(!owner)return url.search?failure(401,'Sign in required'):signInLanding();
      const {items}=await ownerStore('/actions/list',{}) as {items:PendingAction[]};
      const content=approvalInbox(items,owner.csrf);
      if(url.search)return Response.json({html:content,count:items.length},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      return portalPage(pageHeading('Pending approvals','Review requests for your selected computer.')+content,'Pending approvals',{owner});
    }
    if(path==='/devices/actions'&&request.method==='GET'&&/^\?id=[a-f0-9-]{36}$/.test(url.search)) {
      if(!owner)return new Response(null,{status:303,headers:{Location:settings.publicOrigin+(emailAuthEnabled(env)?'/devices/sign-in?':'/devices/login?')+'action='+encodeURIComponent(url.searchParams.get('id')!),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
      const action=await ownerStore('/actions/view',{id:url.searchParams.get('id')}) as {name:string;args:unknown;deviceName:string;status:string;expires:number;autoRun?:boolean;result?:unknown};
      const details=JSON.stringify(action.args,null,2);
      return portalPage('<a class="back-link" href="/devices">Back to devices</a>'+pageHeading('Review computer action','Approve only if you requested this exact action in your assistant.')+'<section class="panel center-card" data-action-return data-action-id="'+escaped(url.searchParams.get('id'))+'" data-action-status="'+escaped(action.status)+'"><div class="panel-body">'+(requiresActionReview(action.name)?'<p class="notice error" role="alert">High-risk or sensitive action. '+escaped(actionPurpose(action.name))+' Review the exact targets before approving once.</p>':'')+'<p><strong>Computer:</strong> '+escaped(action.deviceName)+'</p><p><strong>Tool:</strong> '+escaped(action.name)+'</p><p><strong>Expires:</strong> <time datetime="'+new Date(action.expires).toISOString()+'">'+new Date(action.expires).toISOString()+'</time></p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto">'+escaped(details)+'</pre>'+(action.status==='pending'?(action.autoRun?'<p>Approving runs this exact action once. Its encrypted result is available to your account for 10 minutes.</p>':'')+'<form novalidate data-mutation method="post" action="/devices/actions">'+hidden('csrf',owner.csrf)+hidden('id',url.searchParams.get('id')!)+'<div class="action-row"><button type="submit" class="button danger" name="decision" value="deny">Deny action</button><button type="submit" class="button primary" name="decision" value="approve">'+(action.autoRun?'Approve and run once':'Approve this action once')+'</button></div></form>':'<p>'+escaped(action.autoRun?(action.status==='completed'?'Action finished. No retry is needed.':action.status==='unknown'?'Outcome unknown. Check the computer before starting a new action. Do not retry automatically.':action.status==='running'?'Action is running. Check its result shortly.':'This action was '+action.status+'.'):'This action was '+action.status+'. Return to your assistant and retry the same tool call only if it was approved.')+'</p>'+(action.result?'<h2>Result</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+escaped(JSON.stringify(action.result,null,2))+'</pre>':''))+'</div></section>','Review action',{owner,actionReturn:true});
    }
    if(path==='/devices'&&request.method==='GET'&&(!url.search||/^\?notice=(selected|disconnected|revoked|approved|renamed|revoked-all|pro)$/.test(url.search))) {
      if(!owner)return env.JAN_SITE_ROLE==='public'?signInLanding():portalPage(pageHeading('Your computer. Your approval.','Secure remote computer access through AI.')+'<section class="panel center-card"><div class="panel-body"><a class="button primary" href="/devices/login">Continue with your GitHub account</a></div></section>','Sign in');
      const data=await ownerStore('/device/list',{}) as PortalData;
      return deviceDashboard(data,owner,settings.publicOrigin,url.searchParams.get('notice'),env.JAN_PAIRING_ENABLED==='1',env.JAN_SITE_ROLE!=='public'&&accountId===env.ALLOWED_GITHUB_ID&&env.JAN_MULTI_USER_ENABLED==='1',env.JAN_SITE_ROLE==='public');
    }
    const paymentLink=path==='/devices/plan'&&/^\?_ptxn=txn_[a-z0-9]{26}$/.test(url.search);
    if(request.method==='GET'&&!owner&&paymentLink)return new Response(null,{status:302,headers:{Location:settings.publicOrigin+'/devices/login?checkout='+url.searchParams.get('_ptxn'),'Cache-Control':'no-store'}});
    if(request.method==='GET'&&owner&&['/devices/connect','/devices/assistant','/devices/usage','/devices/settings','/devices/plan'].includes(path)&&(!url.search||path==='/devices/connect'&&/^\?step=(copy|run|assistant|verify)(&os=(windows|linux|macos))?(&client=(chatgpt|claude|cursor))?$/.test(url.search)||path==='/devices/assistant'&&/^\?client=(chatgpt|claude|cursor)$/.test(url.search)||path==='/devices/usage'&&/^\?range=(today|week|last-week|months)$/.test(url.search)||paymentLink)) {
      const data=await ownerStore('/device/list',{}) as PortalData;
      if(path==='/devices/connect')return connectPage(settings.publicOrigin,owner,data,url.searchParams.get('step')??'copy',env.JAN_SITE_ROLE==='public',url.searchParams.get('os')==='linux'?'linux':url.searchParams.get('os')==='macos'?'macos':'windows',url.searchParams.get('client')==='claude'?'claude':url.searchParams.get('client')==='cursor'?'cursor':'chatgpt');
      if(path==='/devices/assistant')return assistantPage(settings.publicOrigin,owner,data,url.searchParams.get('client')==='claude'?'claude':url.searchParams.get('client')==='cursor'?'cursor':'chatgpt');
      if(path==='/devices/usage')return usagePage(data,owner,Date.now(),url.searchParams.get('range')??'months');
      if(path==='/devices/plan') {
        const ready=billingReady(env),live=liveBilling(env),pro=data.plan==='pro';
        let paymentStatus='Payment history unavailable';
        try {const history=await loadBillingHistory(env,accountId!);paymentStatus=history.rows.length?currentPayment(history):pro?'No confirmed payment this month':'Free plan';} catch {}
        const checkout=ready?{environment:live?'production' as const:'sandbox' as const,token:env.PADDLE_CLIENT_TOKEN!,priceId:env.PADDLE_PRICE_ID!,accountId:accountId!,binding:await checkoutBinding(env,accountId!)}:undefined;
        const canceling=data.billing?.find(item=>item.status==='active'&&item.cancelAt);
        const canceled=data.billing?.find(item=>item.status==='canceled');
        const subscriptionNotice=canceling?'<div class="notice" role="status">Your Pro subscription is canceled for renewal and stays active until '+escaped(new Date(canceling.cancelAt!).toLocaleDateString('en-US',{dateStyle:'medium',timeZone:'UTC'}))+'.</div>':canceled&&!pro?'<div class="notice" role="status">Your Pro subscription has ended. Your account is now on Free.</div>':'';
        return portalPage(pageHeading('Plan & billing',live?'Your current plan and subscription status.':'Your current plan and sandbox checkout status.')+subscriptionNotice+'<section class="panel"><div class="panel-body"><div class="setting"><div><strong>Free</strong><p>15,000 MCP tool calls per UTC month and one active computer. Usage resets on the first day of each month.</p></div>'+(pro?'':'<span class="badge read">Current plan</span>')+'</div><div class="setting"><div><strong>Pro — <span data-pro-price>USD 15/month</span></strong><p>Unlimited monthly tool calls and active devices, subject to the per-minute rate limit. Priority support by email; no response-time guarantee is published. <span data-price-note>Base price plus applicable tax. Loading your local price…</span></p></div>'+(pro?'<span class="badge read">Current plan</span>':checkout?'<button type="button" class="button primary" id="pro-checkout">'+(live?'Upgrade to Pro':'Test Pro checkout')+'</button>':'')+'</div><div class="setting"><div><strong>Billing · '+escaped(billingMonth())+'</strong><p>'+escaped(paymentStatus)+'</p></div><a class="button neutral" href="/devices/billing/history">View billing history</a></div></div></section>','Plan & billing',{owner,data,active:'plan',checkout});
      }
      let githubSection='';
      if(emailAuthEnabled(env)&&owner.userId?.startsWith('s-')){
        const github=await deviceStore(env,'/github-identity/status',{accountId:owner.userId}) as {linked:boolean;login?:string};
        githubSection='<section class="panel"><div class="panel-head"><h2>GitHub sign-in</h2></div><div class="panel-body"><div class="setting"><div><strong>'+(github.linked?'Connected: @'+escaped(github.login):'Connect GitHub (optional)')+'</strong><p>'+(github.linked?'Use GitHub or your email/password to open this same PCRC account.':'Add GitHub as another sign-in method. Your computers and subscription stay together.')+'</p></div>'+(github.linked?'<span class="badge read">Connected</span>':'<form method="post" action="/devices/github/link">'+hidden('csrf',owner.csrf)+button('Connect GitHub','neutral')+'</form>')+'</div></div></section>';
      }
      return portalPage(pageHeading('Settings','Account, access and connection controls.')+githubSection+'<section class="panel"><div class="panel-head"><h2>Account</h2></div><div class="panel-body"><div class="setting"><div><strong>'+escaped(owner.login)+'</strong><p>Signed in securely. Computer access is tied to this account.</p></div><form novalidate data-mutation method="post" action="/devices/logout">'+hidden('csrf',owner.csrf)+button('Sign out','neutral')+'</form></div>'+(emailAuthEnabled(env)?'<div class="setting"><div><strong>Email sign-in</strong><p>Link a verified email to keep your existing computers and subscription, or reset your email password.</p></div><a class="button neutral" href="'+(owner.userId?.startsWith('s-')?'/devices/email/forgot':'/devices/email/link')+'">'+(owner.userId?.startsWith('s-')?'Reset password':'Link email sign-in')+'</a></div>':'')+'</div></section><section class="panel"><div class="panel-head"><h2>Computer access</h2><span class="badge read">Per-device permissions</span></div><div class="panel-body"><div class="setting"><div><strong>Approved workspace</strong><p>Standard setup requests file management, terminal, browser and desktop control. Review and approve each requested permission on the verification page. Control also needs pcrc:control OAuth consent. Saved limited devices require fresh approval before gaining control.</p></div>'+icon('shield')+'</div><div class="setting"><div><strong>Connection duration</strong><p>Keep the terminal open to stay connected. PCRC retries temporary network interruptions automatically. Ctrl+C disconnects immediately. An optional --duration-minutes limit can end a session earlier.</p></div></div><div class="setting"><div><strong>Device revocation</strong><p>Revoking a device disconnects it and invalidates its saved identity. A new matching-code approval is needed to reconnect.</p></div><a class="button danger" href="/devices/revoke-all">Revoke all devices</a></div></div></section>','Settings',{owner,data,active:'settings',headers:{'Referrer-Policy':'same-origin'}});
    }
    if(request.method==='GET'&&owner&&['/devices/revoke','/devices/revoke-all','/devices/rename'].includes(path)) {
      const data=await ownerStore('/device/list',{}) as PortalData;
      const all=path==='/devices/revoke-all';
      const id=url.searchParams.get('id');
      const device=all?null:data.devices.find(d=>d.id===id&&!d.revoked);
      if((all&&url.search)||(!all&&(!id||!/^\?id=[a-f0-9-]{36}$/.test(url.search)||!device)))return failure(404,'Computer unavailable');
      const back='<a class="back-link" href="/devices">'+icon('back')+'Back to devices</a>';
      if(path==='/devices/rename')return portalPage(back+pageHeading('Rename computer','Choose a name you will recognize.')+'<section class="panel center-card"><div class="panel-body"><form novalidate data-mutation method="post" action="/devices/rename">'+hidden('csrf',owner.csrf)+hidden('id',device!.id)+'<div class="field"><label for="device-name">Computer name</label><input id="device-name" name="name" value="'+escaped(device!.name)+'" maxlength="64" autocomplete="off" aria-describedby="name-help"><small id="name-help">1–64 letters, numbers, spaces, dots or hyphens.</small></div><div class="action-row">'+button('Save name','primary')+'<a class="button ghost" href="/devices">Cancel</a></div></form></div></section>','Rename computer',{owner,data});
      return revokePage(data,owner,all?null:device!.id);
    }
    if(path.startsWith('/devices/')&&request.method==='POST'&&owner) {
      // Some embedded browsers rewrite Origin on a same-site form POST. The
      // unpredictable per-session CSRF token below is the authorization check.
      if(request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded') return failure(403,'Form denied');
      const form=await request.formData();
      if(form.get('csrf')!==owner.csrf) return failure(403,'Form denied');
      if(path==='/devices/connection-check')return connectionCheckPage(owner,await ownerStore('/connection/check',{discover:true}));
      if(path==='/devices/approvals') {
        const ids=form.getAll('ids'),decision=form.get('decision');
        if(form.get('reviewed')!=='yes'||!['approve','deny'].includes(String(decision))||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id)))return failure(400,'Select and review up to eight requests');
        const {items}=await ownerStore('/actions/list',{}) as {items:PendingAction[]};
        for(const id of ids) {
          const item=items.find(item=>item.id===id),access=form.get('write_'+id)==='yes'?'write':form.get('read_'+id)==='yes'?'read':'none';
          if(!item)return failure(409,'A request expired or changed. Refresh Pending approvals.');
          if(decision==='approve'&&(!['read','write'].includes(String(access))||item.access==='write'&&access!=='write'))return failure(403,'Read-only approval cannot run a write or control action');
        }
        const results=[];
        for(const id of ids) {
          try {await ownerStore('/actions/decide',{id,decision,...(decision==='approve'?{access:form.get('write_'+id)==='yes'?'write':'read'}:{})});results.push({id,ok:true});}
          catch {results.push({id,ok:false});}
        }
        return portalPage(pageHeading('Approval results','Each request is processed once. Check its result in your assistant before retrying.')+'<section class="panel"><div class="panel-body"><p>'+results.filter(item=>item.ok).length+' of '+ids.length+' decisions accepted.</p><ul>'+results.map(item=>'<li><code>'+escaped(String(item.id))+'</code>: '+(item.ok?'Decision recorded. Check the action result.':'Unavailable or changed. Do not repeat automatically.')+'</li>').join('')+'</ul><a class="button primary" href="/devices">Back to dashboard</a> <a href="/devices/approvals">Pending approvals</a></div></section>','Approval results',{owner});
      }
      if(path==='/devices/actions') {
        const id=form.get('id'),decision=form.get('decision');
        if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id)||!['approve','deny'].includes(String(decision)))return failure(400,'Invalid action');
        await ownerStore('/actions/decide',{id,decision});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices/actions?id='+id+'#return-to-chat','Cache-Control':'no-store'}});
      }
      if(path==='/devices/logout') {
        const returnTo=form.has('return')?signInReturn(form.get('return')):null;
        if(form.has('return')&&!returnTo)return failure(400,'Invalid sign-in destination');
        const selected=await portalCookie(request,env);
        if(!selected||selected.accountId!==accountId)return failure(403,'Session denied');
        await ownerStore('/session/delete',{hash:await digest(selected.token)});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+(returnTo?'/devices/sign-in?'+new URLSearchParams({return:returnTo}):'/devices'),'Set-Cookie':'__Host-JanPortal=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0','Cache-Control':'no-store'}});
      }
      if(path==='/devices/revoke-all') {
        if(form.get('confirmation')!=='revoke')return revokePage(await ownerStore('/device/list',{}),owner,null);
        await ownerStore('/device/revoke-all',{});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices?notice=revoked-all','Cache-Control':'no-store'}});
      }
      if(path==='/devices/unselect') {
        const id=form.get('id');
        if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id)) return failure(400,'Invalid device');
        await ownerStore('/device/unselect',{id});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices?notice=disconnected','Cache-Control':'no-store'}});
      }
      if(path==='/devices/approve') {
        const access=await pairingAccount(env,String(form.get('id')),accountId!,form.get('decision')==='approve');
        await deviceStore(env,'/pairing/decide',{id:form.get('id'),decision:form.get('decision'),confirmationCode:form.get('confirmation_code'),codesMatch:form.get('decision')==='approve',capabilities:form.get('access')==='read'?[]:form.get('access')==='control'?form.getAll('capabilities'):null,selectForAi:form.get('select_for_ai')==='yes',ownerId:accountId,login:owner.login,...access});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+(form.get('decision')==='approve'?'/devices/connect?step=assistant':'/devices'),'Cache-Control':'no-store'}});
      }
      if(path==='/devices/new') {
        if(env.JAN_PAIRING_ENABLED==='1') return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices/connect','Cache-Control':'no-store'}});
        const code=randomCode();
        await ownerStore('/pair/create',{hash:await digest(code),login:owner.login});
      return html('<h1>Add a computer</h1><p>Get the PC Remote Commander release from the owner, extract it on this computer, and set it up in a normal-user terminal from that folder. Windows: <code>Setup-Windows.cmd</code>. Linux: <code>bash setup-linux.sh</code>. Setup creates an approved workspace; review its path before granting access.</p><p>Install Node.js 20 or newer. Open a terminal <strong>inside the extracted JAN folder</strong> first. For Windows CMD, run <code>cd /d "C:\\path\\to\\JAN-MCP-Commander"</code> with your actual folder. Then run:</p><p>Windows: <code>npx --offline --yes ./deploy/npm/jan-commander remote --enroll --capabilities files,commands,browser,desktop --browser-channel msedge --duration-minutes 60 --auto-origin '+escaped(settings.publicOrigin)+'</code></p><p>Linux: <code>npx --offline --yes ./deploy/npm/jan-commander remote --enroll --capabilities files,commands,browser --duration-minutes 60 --auto-origin '+escaped(settings.publicOrigin)+'</code></p><p>When the terminal asks, enter this one-time code:</p><p><code>'+escaped(code)+'</code></p><small>Expires in five minutes. Never paste this code into chat or put it in command arguments. Later, use the same npx command without --enroll or --auto-origin from the JAN folder, or call JAN-Remote.cmd by its full path from any Windows folder. Keep the terminal open. A different computer needs its own enrollment.</small><p><a href="/devices">Back to devices</a></p>');
      }
      const id=form.get('id');
      if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id)) return failure(400,'Invalid device');
      if(path==='/devices/revoke'&&form.get('confirmation')!=='revoke')return revokePage(await ownerStore('/device/list',{}),owner,id);
      if(path==='/devices/rename') {
        const name=form.get('name');
        if(typeof name!=='string'||! /^[\w .-]{1,64}$/.test(name))return portalPage(pageHeading('Check the computer name','Use 1–64 letters, numbers, spaces, dots or hyphens.')+'<section class="panel"><div class="panel-body"><form novalidate data-mutation method="post" action="/devices/rename">'+hidden('csrf',owner.csrf)+hidden('id',id)+'<div class="field"><label for="device-name">Computer name</label><input id="device-name" name="name" value="'+escaped(typeof name==='string'?name.slice(0,64):'')+'" aria-invalid="true" aria-describedby="name-error"><small id="name-error">Use letters, numbers, spaces, dots or hyphens.</small></div>'+button('Save name')+'</form></div></section>','Check computer name',{owner,status:400});
        await ownerStore('/device/rename',{id,name});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices?notice=renamed','Cache-Control':'no-store'}});
      }
      if(path==='/devices/select'||path==='/devices/revoke') {
        await ownerStore(path.replace('/devices','/device'),{id});
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+'/devices?notice='+(path==='/devices/select'?'selected':'revoked'),'Cache-Control':'no-store'}});
      }
    }
    return failure(owner?404:403,owner?'Not found':'Sign in required');
  } catch (error) {
    if(path==='/admin/accounts'&&error instanceof DeviceStateError&&error.status===409)return html('<h1>Account deletion was not started</h1><p>Cancel all subscriptions and wait for cancellation to take effect before deleting this account. No files on the computer were deleted.</p><a href="/admin/accounts">Back to user accounts</a>',409);
    if(path==='/devices/approve'&&error instanceof DeviceStateError){
      const current=await session(request,env).catch(()=>null);
      const id=request.method==='GET'?url.searchParams.get('id'):null;
      const back=id&&/^[A-Za-z0-9_-]{43}$/.test(id)?'/devices/approve?id='+id:'/devices/connect';
      const wrong=error.status===403,limited=error.status===429,paid=error.status===402;
      return portalPage(pageHeading(wrong?'This is not the correct account':limited?'Free computer limit reached':paid?'Pro required for this shared computer':'This connection request is unavailable',wrong?'Sign in with the PCRC account you originally connected to this computer.':limited?'Free accounts can connect one computer. Revoke the previous computer or upgrade to Pro.':paid?'Shared installations require Pro on each account. Use the original installation account, upgrade, or ask the owner to release the computer.':'The request expired, was already used, or could not be loaded. Run setup again to obtain a fresh request.')+'<section class="panel center-card"><div class="panel-body"><p>No new computer access was granted.</p>'+(current&&wrong?'<form method="post" action="/devices/logout">'+hidden('csrf',current.csrf)+hidden('return',back)+button('Sign out and use the correct account')+'</form>':'<a class="button primary" href="/devices">Your devices</a>')+'</div></section>','Connection needs attention',{owner:current??undefined,status:error.status});
    }
    if(path==='/devices/actions'&&error instanceof DeviceStateError&&[404,409].includes(error.status))return portalPage(pageHeading('Action unavailable','This action expired, your selected computer changed, or you signed in with a different PCRC account.')+'<section class="panel center-card"><div class="panel-body"><p>Use the account that owns the computer. Check the result in your assistant before requesting a replacement action.</p><a class="button primary" href="/devices">Check your devices</a></div></section>','Action unavailable',{owner:await session(request,env).catch(()=>undefined)??undefined,status:error.status});
    if(path==='/devices/github/link'&&error instanceof DeviceStateError)console.warn('PCRC_GITHUB_LINK_START_FAILED',JSON.stringify({status:error.status}));
    if(path.startsWith('/devices/github/')&&error instanceof DeviceStateError&&error.status===403)return html('<h1>Start a fresh GitHub connection</h1><p>The connection review expired or your PCRC session changed. Open Settings and start again. If you reset your password, sign in again first.</p><a href="/devices/settings">Back to Settings</a>',403);
    if(error instanceof AccountAccessDenied)return html('<h1>This account does not have access yet</h1><p>PCRC is currently limited to approved test accounts. Sign in with your approved GitHub account or contact <a href="/support">support</a> to request access.</p><p><a href="/devices">Return to sign-in</a></p>',403,{'Cache-Control':'no-store','Set-Cookie':'__Host-JanPortalOAuth=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
    if(error instanceof DeviceStateError&&error.status===410)return html('<h1>This PCRC account is closed</h1><p>Its device and assistant access is blocked. Contact <a href="/support">support</a> if you need help. Signing in again does not recreate a deleted account.</p>',410,{'Set-Cookie':'__Host-JanPortal=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
    if(path.startsWith('/devices/github/')&&error instanceof DeviceStateError&&error.status===409)return html('<h1>GitHub cannot be connected</h1><p>That GitHub identity or this PCRC account is already linked. No accounts were merged.</p><a href="/devices/settings">Back to Settings</a>',409);
    if(path==='/admin/prompts'&&error instanceof DeviceStateError)return failure(error.status,'Prompt update was rejected. Check field lengths, choose an existing category, and use a unique category name. Limit: 30 categories and 50 prompts including deleted entries. Return to Website prompts to review.');
    if(error instanceof DeviceStateError && [400,403,404,409,410,429].includes(error.status)) return failure(error.status,error.status===429?'Rate or device limit reached':error.status===409?'Pairing changed or device key is not verified; refresh the page':'Device code, session, or device was denied');
    if(path==='/admin/subscriptions')return failure(502,'Paddle could not confirm this billing action. Check its sandbox dashboard before retrying; cancellation or a refund request may already have succeeded.');
    return failure(503,'Device portal unavailable or sign-in expired');
  }
}
