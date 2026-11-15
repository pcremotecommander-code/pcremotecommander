import {boundedBody,config,escaped,failure,type Settings} from './policy.ts';
import {openRecord,sealRecord,type SealedRecord} from './secure_store.ts';
import {authenticatedAccountId,EMAIL_USERNAME_PATTERN,validEmailUsername} from './account_identity.ts';
import {createPortalSession,deviceStore,digest,randomCode,session,DeviceStateError,type DeviceEnv} from './device_portal.ts';
import {signInReturn} from './portal_return.ts';
import {signInLanding,authField,portalPage} from './portal_ui.ts';
import {s256} from './authorization.ts';

const FLOW='__Host-PcrcEmailFlow',RESET='__Host-PcrcPasswordReset',COMPLETE='__Host-PcrcEmailComplete';
type Flow={csrf:string;verifier:string;mode:string;returnTo:string;linkAccount?:string};
type User={id:string;email_confirmed_at:string;email:string;user_metadata?:{pcrc_username?:unknown}};
class AuthRejected extends Error {status:number;fields:string[];constructor(status=400,message='Sign-in failed. Check your PCRC username or email and password, or request a password reset. If you joined using GitHub, sign in with GitHub first.',fields:string[]=[]){super(message);this.status=status;this.fields=fields;}}
export function emailAuthEnabled(env:Settings):boolean {
 return env.PCRC_EMAIL_AUTH_ENABLED==='1'&&env.JAN_SITE_ROLE==='public'&&env.JAN_MULTI_USER_ENABLED==='1'&&/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL??'')&&/^sb_publishable_[A-Za-z0-9_-]{15,200}$/.test(env.SUPABASE_PUBLISHABLE_KEY??'');
}
const cookie=(name:string,value:string,seconds=900)=>name+'='+value+'; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age='+seconds;
async function seal(env:DeviceEnv,purpose:string,value:Record<string,unknown>,seconds=900):Promise<string>{
 return btoa(JSON.stringify(await sealRecord(env.JAN_PROXY_KEY,config(env).publicOrigin,purpose,value,Date.now()+seconds*1000))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function unseal<T>(request:Request,env:DeviceEnv,name:string,purpose:string):Promise<T>{
 const raw=(request.headers.get('Cookie')??'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
 if(!raw||raw.length>6000||!/^[A-Za-z0-9_-]+$/.test(raw))throw new AuthRejected(400,'This form expired. Open the sign-in page and try again.');
 try{const record=JSON.parse(atob(raw.replace(/-/g,'+').replace(/_/g,'/'))) as SealedRecord;if(record.expires<=Date.now()||record.expires>Date.now()+901000)throw Error();return await openRecord<T>(env.JAN_PROXY_KEY,config(env).publicOrigin,purpose,record);}catch{throw new AuthRejected(400,'This form expired. Open the sign-in page and try again.');}
}
async function api(env:DeviceEnv,path:string,body?:unknown,token?:string,method=body===undefined?'GET':'POST',fetcher:typeof fetch=fetch):Promise<any>{
 // Workers supports manual, not error; never follow redirects carrying credentials.
 const response=await fetcher(env.SUPABASE_URL+'/auth/v1'+path,{method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY!,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 if(response.status>=300&&response.status<400)throw new AuthRejected(502,'Sign-in service returned an unexpected redirect. Try again later.');
 const bytes=await boundedBody(new Request('https://response.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),32768);
 if(response.status>=500)throw new AuthRejected(503,'Sign-in service is temporarily unavailable. Try again shortly.');
 if(!response.ok&&path==='/token?grant_type=password'&&response.status!==429){
  let code='';try{code=JSON.parse(new TextDecoder().decode(bytes)).code??'';}catch{}
  if(code==='email_not_confirmed')throw new AuthRejected(400,'Verify your email before signing in. Open your PCRC verification email, then return here.',['email']);
  if([401,403].includes(response.status)&&code!=='invalid_credentials')throw new AuthRejected(503,'Sign-in service is temporarily unavailable. Try again shortly or use GitHub.');
  throw new AuthRejected(400,'Sign-in failed. Check your PCRC username or email and password, or request a password reset. If you joined using GitHub, sign in with GitHub first.',['email','password']);
 }
 if(!response.ok)throw new AuthRejected(response.status===429?429:400,response.status===429?'Too many attempts. Wait before trying again.':'The request could not be completed. Check your details or try again later.');
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AuthRejected(502,'Sign-in service unavailable. Try again shortly.');}
}
async function verifiedUser(env:DeviceEnv,token:unknown,fetcher:typeof fetch):Promise<User>{
 if(typeof token!=='string'||token.length<20||token.length>8192)throw new AuthRejected();
 const user=await api(env,'/user',undefined,token,'GET',fetcher);
 if(!authenticatedAccountId('s-'+user.id)||typeof user.email!=='string'||typeof user.email_confirmed_at!=='string'||!Number.isFinite(Date.parse(user.email_confirmed_at)))throw new AuthRejected(403,'Verify your email before signing in.');
 return user;
}
function destination(url:URL):string {
 if(!url.search)return '/devices';
 if([...url.searchParams.keys()].length!==1)throw new AuthRejected(400,'Invalid sign-in destination');
 if(url.searchParams.has('return')){const value=signInReturn(url.searchParams.get('return'));if(value)return value;}
 for(const [key,prefix,pattern] of [['consent','/consent?handle=',/^[A-Za-z0-9_-]{43}$/],['pair','/devices/approve?id=',/^[A-Za-z0-9_-]{43}$/],['action','/devices/actions?id=',/^[a-f0-9-]{36}$/],['checkout','/devices/plan?_ptxn=',/^txn_[a-z0-9]{26}$/]] as const){const value=url.searchParams.get(key);if(value&&pattern.test(value))return prefix+value;}
 throw new AuthRejected(400,'Invalid sign-in destination');
}
function password(form:URLSearchParams,strict:boolean):string {
 const value=form.get('password')??'';
 if(value.length<(strict?12:1)||new TextEncoder().encode(value).length>72)throw new AuthRejected(400,strict?'Use a password with at least 12 characters and at most 72 UTF-8 bytes.':'Check your password.',['password']);
 if(strict&&value!==form.get('confirmation'))throw new AuthRejected(400,'The two passwords do not match.',['password','confirmation']);
 if(strict&&(!/[A-Z]/.test(value)||!/[a-z]/.test(value)||!/[0-9]/.test(value)||!(/[^A-Za-z0-9\s]/.test(value))))throw new AuthRejected(400,'Include an uppercase letter, a lowercase letter, a number and a symbol.',['password']);
 return value;
}
function email(form:URLSearchParams):string {
 const value=(form.get('email')??'').trim().toLowerCase();if(value.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw new AuthRejected(400,'Enter a valid email address.',['email']);return value;
}
async function formBody(request:Request,env:DeviceEnv):Promise<URLSearchParams>{
 if(request.headers.get('Origin')!==config(env).publicOrigin||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')throw new AuthRejected(403,'Form origin denied');
 return new URLSearchParams(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await boundedBody(request,4096)));
}
const passwordRules='At least 12 characters, with uppercase, lowercase, a number and a symbol. Maximum 72 UTF-8 bytes.';
async function view(env:DeviceEnv,mode:string,returnTo='/devices',notice='',linkAccount?:string,invalid:string[]=[],values:Record<string,string>={}):Promise<Response>{
 const flow:Flow={csrf:randomCode(),verifier:randomCode()+randomCode(),mode,returnTo,...(linkAccount?{linkAccount}:{})};
 const login='/devices/login?'+new URLSearchParams({return:returnTo});
 const heading=mode==='signup'?'Create your account':mode==='forgot'?'Reset your password':mode==='link'?'Link email sign-in':'Welcome back';
 const field=(label:string,name:string,type:string,complete:string,rule='',required=true)=>authField(label,name,type,complete,{value:values[name],error:invalid.includes(name)?notice:'',rule,required});
 const action=mode==='signin'?'/devices/email/sign-in':'/devices/email/'+mode;
 const content=(notice?'<p class="notice" role="'+(invalid.length?'alert':'status')+'">'+escaped(notice)+'</p>':'')+
 '<form class="email-auth-form" data-auth-mode="'+mode+'" method="post" action="'+action+'"><input type="hidden" name="csrf" value="'+flow.csrf+'">'+
 field(mode==='signin'?'Email or username':'Email address','email',mode==='signin'?'text':'email',mode==='signin'?'username':'email')+
 (mode==='signup'?field('Username','username','text','username','pattern="'+EMAIL_USERNAME_PATTERN+'" minlength="3"')+'<small>3–12 lowercase letters or numbers only. No spaces or symbols.</small>':'')+
 (mode==='forgot'?'':field('Password','password','password',mode==='signup'?'new-password':'current-password'))+
 (mode==='signup'||mode==='link'?field('Confirm password','confirmation','password','new-password','',mode!=='link')+'<p class="password-rules">'+passwordRules+'</p>':'')+
 '<button class="button primary" type="submit" name="action" value="login">'+(mode==='signup'?'Create account':mode==='forgot'?'Send reset email':mode==='link'?'Link existing email':'Sign in')+'</button>'+
 (mode==='link'?'<button class="button neutral" type="submit" name="action" value="signup">Create and link email</button>':'')+'</form>'+
 (mode==='signin'?'<div class="email-auth-links"><a href="/devices/email/forgot">Forgot password?</a><a href="/devices/email/signup?'+new URLSearchParams({return:returnTo})+'">Create account</a></div><p class="email-auth-divider">or continue with GitHub</p>':'<p class="email-auth-links"><a href="/devices/sign-in?'+new URLSearchParams({return:returnTo})+'">Back to sign-in</a></p>');
 const response=signInLanding(login,content,heading,mode==='link'?'Keep your existing computers and subscription.':'Use your email and password');
 response.headers.append('Set-Cookie',cookie(FLOW,await seal(env,'email-flow',flow)));
 return response;
}
function resetView(csrf:string,notice='',invalid:string[]=[]):Response {
 const field=(label:string,name:string)=>authField(label,name,'password','new-password',{error:invalid.includes(name)?notice:''});
 return signInLanding('/devices/login',(notice?'<p class="notice error" role="alert">'+escaped(notice)+'</p>':'')+'<form class="email-auth-form" data-auth-mode="reset" method="post" action="/devices/email/reset"><input type="hidden" name="csrf" value="'+escaped(csrf)+'">'+field('New password','password')+field('Confirm password','confirmation')+'<p class="password-rules">'+passwordRules+'</p><button class="button primary" type="submit">Save new password</button></form>','Choose a new password','Use a strong, unique password');
}
async function resolve(env:DeviceEnv,user:User,linkAccount?:string):Promise<{id:string;login:string}>{
 if(linkAccount)await deviceStore(env,'/email-identity/link',{subject:user.id,accountId:linkAccount});
 const result=await deviceStore(env,'/email-identity/resolve',{subject:user.id,email:user.email.toLowerCase(),username:user.user_metadata?.pcrc_username});
 if(!authenticatedAccountId(result.id))throw new AuthRejected(403);
 const item=await deviceStore(env,'/directory/find',{query:result.id});
 return {id:result.id,login:typeof item.login==='string'?item.login:result.username};
}
function clear(response:Response):Response {response.headers.append('Set-Cookie',cookie(FLOW,'',0));response.headers.append('Set-Cookie',cookie(RESET,'',0));return response;}
async function completedVerification(request:Request,env:DeviceEnv):Promise<{flow:string;target:string}|null>{
 let value:{flow:string;accountId:string;target:string};
 try{value=await unseal(request,env,COMPLETE,'email-complete');}catch(error){if(error instanceof AuthRejected)return null;throw error;}
 if(!/^[A-Za-z0-9_-]{43}$/.test(value.flow)||!signInReturn(value.target))return null;
 const owner=await session(request,env);
 return owner?.userId===value.accountId?{flow:value.flow,target:value.target}:null;
}
export async function emailAuth(request:Request,env:DeviceEnv,fetcher:typeof fetch=fetch):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname;
 const relevant=path.startsWith('/devices/email/')||path==='/devices/sign-in'||path==='/devices'&&request.method==='GET';
 if(!relevant)return null;
 if(!emailAuthEnabled(env))return path.startsWith('/devices/email/')?failure(503,'Email sign-in is not configured. Use GitHub for now.'):null;
 let recoveryStarted=false,stage="form";
 let context:{flow:Flow;values:Record<string,string>}|undefined,resetCsrf:string|undefined;
 try{
  if(request.method==='GET'&&(path==='/devices'||path==='/devices/sign-in')){
   const owner=await session(request,env);
   const target=path==='/devices'?'/devices':destination(url);
   if(owner)return path==='/devices'?null:new Response(null,{status:303,headers:{Location:config(env).publicOrigin+target,'Cache-Control':'no-store'}});
   return view(env,'signin',target);
  }
  if(request.method==='GET'&&['/devices/email/signup','/devices/email/forgot','/devices/email/link'].includes(path)){
   const mode=path.split('/').at(-1)!;
   if(mode==='link'){const owner=await session(request,env);if(!owner||owner.userId.startsWith('s-'))throw new AuthRejected(403,'Sign in to your existing GitHub PCRC account before linking email.');return view(env,mode,'/devices/settings','',owner.userId);}
   return view(env,mode,destination(url));
  }
  if(path==='/devices/email/verified'&&request.method==='GET'){
   const completed=await completedVerification(request,env);
   if(!completed)throw new AuthRejected(403,'This verification page expired. Open your dashboard or sign in again.');
   return portalPage('<section class="panel center-card" data-email-verification="complete" data-flow="'+completed.flow+'" data-target="'+escaped(completed.target)+'"><div class="panel-body"><h1>Verification completed</h1><p>Your email is verified and you are signed in. Returning to your original PCRC tab…</p><p role="status" data-verification-status>You can also open your dashboard below.</p><div class="action-row"><a class="button primary" href="'+escaped(completed.target)+'">Open dashboard</a><button class="button neutral" type="button" data-verification-close>Close this tab</button></div></div></section>','Email verified',{emailVerification:true,headers:{'Referrer-Policy':'same-origin'}});
  }
  if(path==='/devices/email/callback'&&request.method==='GET'){
   if([...url.searchParams.keys()].some(k=>k!=='code'&&k!=='reset')||url.searchParams.getAll('code').length!==1||url.searchParams.getAll('reset').length>1||!url.searchParams.get('code')||url.searchParams.get('code')!.length>512)throw new AuthRejected(400,'This email link is invalid or expired. Request a new one.');
   let invited:{accountId:string;subject:string;email:string;verifier:string}|undefined,flow:Flow;
   if(url.searchParams.has('reset')){
    const reset=url.searchParams.get('reset')!;if(!/^[A-Za-z0-9_-]{43}$/.test(reset))throw new AuthRejected(400,'This reset link is invalid or expired.');
    try{invited=await deviceStore(env,'/owner-data/reset-consume',{hash:await digest(reset)});}catch{throw new AuthRejected(400,'This reset link expired or was already used. Request a new reset.');}
    flow={mode:'forgot',verifier:invited!.verifier,csrf:'',returnTo:'/devices'};
   }else flow=await unseal<Flow>(request,env,FLOW,'email-flow');
   if(!['signup','link','forgot'].includes(flow.mode))throw new AuthRejected();
   const data=await api(env,'/token?grant_type=pkce',{auth_code:url.searchParams.get('code'),code_verifier:flow.verifier},undefined,'POST',fetcher);
   const user=await verifiedUser(env,data.access_token,fetcher);
   if(invited&&(user.id!==invited.subject||user.email.toLowerCase()!==invited.email))throw new AuthRejected(403,'This reset link does not match the account or its current email. Request a new reset.');
   if(flow.mode==='forgot'){
    const identity=await resolve(env,user),nonce=randomCode();
    if(invited&&identity.id!==invited.accountId)throw new AuthRejected(403,'This account changed. Request a new reset.');
    await deviceStore(env,'/email-recovery/create',{hash:await digest(nonce),subject:user.id},identity.id);
    const value=await seal(env,'email-reset',{token:data.access_token,subject:user.id,accountId:identity.id,nonce,csrf:randomCode()},300);
    return new Response(null,{status:303,headers:{Location:config(env).publicOrigin+'/devices/email/reset','Set-Cookie':cookie(RESET,value,300),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
   }
   if(flow.mode==='link'){const owner=await session(request,env);if(!owner||owner.userId!==flow.linkAccount)throw new AuthRejected(403,'Sign in to the original PCRC account and link email again.');}
   const identity=await resolve(env,user,flow.linkAccount);
   const version=await deviceStore(env,'/account/auth-version',{},identity.id);if(version.authVersion!==0)throw new AuthRejected(403,'Email verified. Sign in with your password to continue.');
   const response=clear(await createPortalSession(env,identity,flow.returnTo,0));
   const completion=await seal(env,'email-complete',{flow:flow.csrf,accountId:identity.id,target:signInReturn(flow.returnTo)??'/devices'},300);
   response.headers.append('Set-Cookie',cookie(COMPLETE,completion,300));
   response.headers.set('Location',config(env).publicOrigin+'/devices/email/verified');
   return new Response(null,{status:303,headers:response.headers});
  }
  if(path==='/devices/email/reset'&&request.method==='GET'){
   const reset=await unseal<{csrf:string}>(request,env,RESET,'email-reset');
   return resetView(reset.csrf);
  }
  if(request.method!=='POST')throw new AuthRejected(405,'Method not allowed');
  const form=await formBody(request,env);
  if(path==='/devices/email/verification-status'){
   const completed=await completedVerification(request,env);
   return Response.json(completed&&form.get('flow')===completed.flow?{verified:true,target:completed.target}:{verified:false},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(path==='/devices/email/reset'){
   const reset=await unseal<{csrf:string;token:string;subject:string;accountId:string;nonce:string}>(request,env,RESET,'email-reset');
   if(form.get('csrf')!==reset.csrf)throw new AuthRejected(403,'Form verification failed');
   resetCsrf=reset.csrf;
   const user=await verifiedUser(env,reset.token,fetcher);if(user.id!==reset.subject)throw new AuthRejected(403);
   const next=password(form,true);
   const consumed=await deviceStore(env,'/email-recovery/consume',{hash:await digest(reset.nonce),subject:user.id},reset.accountId);recoveryStarted=true;
   await api(env,'/user',{password:next},reset.token,'PUT',fetcher);
   await deviceStore(env,'/account/reset-finish',{authVersion:consumed.authVersion},reset.accountId);
   // Recovery sessions cannot be used to control a computer; require a fresh password sign-in.
   const response=await view(env,'signin','/devices','Password updated. Sign in with your new password. Existing PCRC sessions and assistant grants have been invalidated.');
   response.headers.append('Set-Cookie',cookie(RESET,'',0));return response;
  }
  const flow=await unseal<Flow>(request,env,FLOW,'email-flow');
  if(form.get('csrf')!==flow.csrf||path!=='/devices/email/'+(flow.mode==='signin'?'sign-in':flow.mode))throw new AuthRejected(403,'Form verification failed');
  context={flow,values:{email:(form.get('email')??'').slice(0,254),username:(form.get('username')??'').slice(0,254)}};
  if(flow.mode==='link'){const owner=await session(request,env);if(!owner||owner.userId!==flow.linkAccount)throw new AuthRejected(403,'The PCRC account session changed. Start linking again.');}
  let address:string;
  if((flow.mode==='signin'||flow.mode==='link')&&form.get('action')!=='signup'&&!(form.get('email')??'').includes('@')){
   const username=(form.get('email')??'').trim().toLowerCase();
   if(!/^[a-z0-9][a-z0-9_-]{2,36}$/.test(username))throw new AuthRejected(400,undefined,['email','password']);
   const found=await deviceStore(env,'/email-identity/lookup',{username});if(typeof found.email!=='string')throw new AuthRejected(400,undefined,['email','password']);address=found.email;
  }else address=email(form);
  if(flow.mode==='forgot'||flow.mode==='signup'||flow.mode==='link'&&form.get('action')==='signup'){
   const username=form.get('username')??'';
   if(flow.mode==='signup'&&!validEmailUsername(username))throw new AuthRejected(400,'Use 3–12 lowercase letters or numbers only. No spaces or symbols.',['username']);
   if(flow.mode==='signup'&&!(await deviceStore(env,'/email-identity/available',{username})).available)throw new AuthRejected(409,'That username is unavailable. Choose another username.',['username']);
   const body={email:address,...(flow.mode==='signup'?{data:{pcrc_username:username}}:{}),code_challenge:await s256(flow.verifier),code_challenge_method:'s256',...(flow.mode==='forgot'?{}:{password:password(form,true)})};
   try{
   stage='provider-email';
   await api(env,(flow.mode==='forgot'?'/recover':'/signup')+'?redirect_to='+encodeURIComponent(config(env).publicOrigin+'/devices/email/callback'),body,undefined,'POST',fetcher);
   }catch(error){if(flow.mode!=='forgot'||!(error instanceof AuthRejected)||error.status!==400)throw error;}
   const waiting=flow.mode!=='forgot';
   const response=signInLanding('/devices/login','<section'+(waiting?' data-email-verification="waiting" data-flow="'+flow.csrf+'"':'')+'><p class="notice" role="status">If this address can receive the requested message, check its inbox. Open the email link in this same browser.</p>'+(waiting?'<p data-verification-status role="status">This tab will open your dashboard automatically after verification.</p>':'')+'<p><a href="/devices/sign-in">Back to sign-in</a></p></section>','Check your email','Verification and reset links expire.',waiting);
   return response;
  }
  stage='identity-lookup';
  const hint=await deviceStore(env,'/email-identity/lookup-email',{email:address});
  const snapshot=hint.id?await deviceStore(env,'/account/auth-version',{},hint.id):{authVersion:0,resetting:false};
  if(snapshot.resetting)throw new AuthRejected(409,'Password recovery is in progress. Complete it or request a new reset link.');
  stage='provider-sign-in';
  const data=await api(env,'/token?grant_type=password',{email:address,password:password(form,false)},undefined,'POST',fetcher);
  const user=await verifiedUser(env,data.access_token,fetcher),identity=await resolve(env,user,flow.linkAccount);
  return clear(await createPortalSession(env,identity,flow.returnTo,hint.id===identity.id?snapshot.authVersion:0));
 }catch(error){
  if(!(error instanceof AuthRejected))console.warn('PCRC_EMAIL_AUTH_FAILURE',JSON.stringify({stage,kind:error instanceof DeviceStateError?'private-state':error instanceof TypeError?'type':'internal',status:error instanceof DeviceStateError?error.status:0}));
  const known=error instanceof AuthRejected,errorStatus=known?error.status:error instanceof DeviceStateError&&[403,409,410,429].includes(error.status)?error.status:503;
  const message=recoveryStarted?'The password change could not be confirmed. Previous PCRC sessions are blocked. Request a new reset link before trying again.':errorStatus===410?'This PCRC account is closed. Contact support if you need help.':known?error.message:'Email authentication is temporarily unavailable. Retry shortly or use GitHub.';
  if(!recoveryStarted&&known&&error.fields.length&&resetCsrf){const page=resetView(resetCsrf,message,error.fields);return new Response(page.body,{status:errorStatus,headers:page.headers});}
  if(context&&(known&&errorStatus!==403||errorStatus>=500)){const page=await view(env,context.flow.mode,context.flow.returnTo,message,context.flow.linkAccount,known?error.fields:[],context.values);return new Response(page.body,{status:errorStatus,headers:page.headers});}
  const response=signInLanding('/devices/login','<p class="notice error" role="alert">'+escaped(message)+'</p><p><a href="/devices/sign-in">Return to sign-in</a> · <a href="/devices/email/forgot">Request a password reset</a></p>','Sign-in needs attention','Your account access stays protected');
  return new Response(response.body,{status:errorStatus,headers:response.headers});
 }
}
