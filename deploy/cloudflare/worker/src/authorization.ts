import type {OAuthHelpers,AuthRequest,ConsentDescription} from '@cloudflare/workers-oauth-provider';
import {config,escaped,failure} from './policy.ts';
import {portalStyles} from './portal_ui.ts';
import {permittedAccount} from './account_identity.ts';
import {session,deviceStore,resolveGitHubAccount,type DeviceEnv} from './device_portal.ts';
import {nativeConfirmationHost,verifiedConfirmationHost,confirmationProps,requiresWebsiteApproval} from './native_confirmation.ts';
import {SUPPORTED_SCOPES,hasReadScope,hasControlScope,displayScopes} from './oauth_scopes.ts';

export interface AuthEnv extends DeviceEnv {OAUTH_PROVIDER: OAuthHelpers;}
async function consentHash(handle:string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(handle))),b=>b.toString(16).padStart(2,'0')).join('');
}
function consentHeaders(redirectUri?:string) {
  // Chromium also checks form-action against redirects after a form POST.
  // Include only the provider-validated client's exact return origin, so Deny
  // can return to that client after a form POST.
  const clientOrigin=redirectUri?' '+new URL(redirectUri).origin:'';
  return new Headers({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'strict-origin','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com"+clientOrigin+"; frame-ancestors 'none'; base-uri 'none'"});
}
function restartConsentPage():Response {
  const headers=consentHeaders();headers.set('Referrer-Policy','no-referrer');
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Restart connection</title><style>'+portalStyles+'</style><main class="content center-card"><h1>Start a new connection</h1><section class="panel"><div class="panel-body"><p>This approval page is no longer valid. No new access was granted by this submission.</p><p>If your AI app already says connected, return there and try a connection check. Otherwise, start Connect again from that app and finish in the same browser within 10 minutes, with cookies enabled.</p><p>Do not refresh or resubmit this approval page.</p><a class="button primary" href="/devices">Open PCRC devices</a></div></section></main></html>',{status:400,headers});
}
export function consentPage(details: ConsentDescription,handle:string,login?:string,websiteApproval=false) {
  const control=hasControlScope(details.scope);
  const host=control?(websiteApproval?verifiedConfirmationHost(details):nativeConfirmationHost(details.redirectUri)):null;
  const publisher=details.clientDomain ? `Verified client domain: ${escaped(details.clientDomain)}` : 'This client name is self-registered and is not verified.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize PC Remote Commander</title><style>${portalStyles}</style><main class="content center-card">
<h1>Authorize PC Remote Commander</h1><section class="panel"><div class="panel-body"><p>Allow <strong>${escaped(details.clientName)}</strong> to ${control?'control locally enabled files, terminal commands, browser and desktop as your OS account? Commands are not confined to the workspace.':'read the approved workspace and run its fixed diagnostics?'}</p>
<p>${publisher}</p><p>Access returns to <strong>${escaped(details.redirectHost)}</strong>.</p>
${login?'<p>Signed in as <strong>'+escaped(login)+'</strong>. Make sure this is the account that owns the computer you selected.</p>':''}
${details.redirectIsLoopback?'<p>This returns access to a local application. Continue only if you started it.</p>':''}
<p>Permissions: ${escaped(displayScopes(details.scope).join(', '))}. ${control?'Computer control also requires an unexpired local capability grant. Whole-screen captures and command output may contain private data.':'This read-only grant cannot edit files or control commands, browser or desktop.'}</p>
${host?'<p class="footnote">'+(host==='chatgpt'?'ChatGPT':'Claude')+' handles tool confirmations for this connection. Its settings may remember choices or automatically allow calls. These host settings apply to every tool, including commands and file changes. PCRC does not add a second dashboard approval for this verified connection. PCRC enforces your account, OAuth scopes, selected computer and locally approved capabilities.</p>':control?'<p class="footnote">Computer actions from this client require approval on the PCRC website.</p>':''}
<form novalidate method="post" action="/authorize"><input type="hidden" name="handle" value="${escaped(handle)}"><div class="action-row"><button class="button primary" name="decision" value="approve">Allow access</button> <button class="button ghost" name="decision" value="deny">Deny</button></div></form></div></section></main></html>`;
}
export async function s256(value:string) {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function requirePkce(request:AuthRequest, resource:string) {
  if (request.resource!==resource || request.codeChallengeMethod!=='S256' || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge??'') || request.scope.some(s=>!SUPPORTED_SCOPES.includes(s)) || !hasReadScope(request.scope)) throw new Error('Invalid authorization policy');
}
function chatGptCallbackEvidence(request:AuthRequest,redirectTo:string,issuer:string):void {
  const returned=new URL(redirectTo);
  if(returned.hostname!=='chatgpt.com')return;
  const state=returned.searchParams.get('state');
  console.info('PCRC_CHATGPT_CALLBACK',JSON.stringify({callbackMode:returned.pathname==='/connector_platform_oauth_redirect'?'stable':'specific',codePresent:!!returned.searchParams.get('code'),requestStatePresent:typeof request.state==='string'&&request.state.length>0,statePresent:!!state,stateMatches:typeof request.state==='string'&&state===request.state,issuerPresent:!!returned.searchParams.get('iss'),issuerMatches:returned.searchParams.get('iss')===issuer}));
}
export async function authorization(request: Request,env:AuthEnv,fetcher:typeof fetch=fetch):Promise<Response> {
  const settings=config(env); const url=new URL(request.url); const oauth=env.OAUTH_PROVIDER;
  if (url.origin!==settings.publicOrigin) return failure(403,'Origin denied');
  let stage='request';
  try {
    if (url.pathname==='/authorize' && request.method==='GET') {
      stage='consent-start';
      const original=await oauth.parseAuthRequest(request); requirePkce(original,settings.resource);
      const details=await oauth.describeConsent(original);
      const consent=await oauth.beginConsent(original);
      if(!env.OAUTH_KV) return failure(503,'Authorization service unavailable');
      // Keep only display metadata under a hash. The provider owns the encrypted
      // request and one-time transaction; this record cannot authorize anything.
      await env.OAUTH_KV.put('pc:consent-page:'+await consentHash(consent.handle),JSON.stringify(details),{expirationTtl:600});
      consent.headers.set('Location',settings.publicOrigin+'/consent?handle='+encodeURIComponent(consent.handle));
      consent.headers.set('Referrer-Policy','no-referrer');
      return new Response(null,{status:303,headers:consent.headers});
    }
    if(url.pathname==='/consent'&&request.method==='GET') {
      stage='consent-browser-check';
      const handle=url.searchParams.get('handle');
      if(!handle||!/^[A-Za-z0-9_-]{43}$/.test(handle))return failure(400,'Restart sign-in from your MCP client');
      const hash=await consentHash(handle),name='__Host-oauth-consent-'+hash.slice(0,16);
      const bound=(request.headers.get('Cookie')??'').split(';').some(c=>c.trim()===name+'='+hash);
      if(!bound) {
        return restartConsentPage();
      }
      const details=await env.OAUTH_KV?.get<ConsentDescription>('pc:consent-page:'+hash,'json');
      if(!details)return restartConsentPage();
      const signedIn=env.JAN_SITE_ROLE==='public'?await session(request,env).catch(()=>null):null;
      if(env.JAN_SITE_ROLE==='public'&&!signedIn)
        return new Response(null,{status:303,headers:{Location:settings.publicOrigin+(env.PCRC_EMAIL_AUTH_ENABLED==='1'?'/devices/sign-in?consent=':'/devices/login?consent=')+handle,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
      // A refresh reuses the same cookie-bound transaction instead of replacing
      // the hidden form handle while the user is reviewing permissions.
      return new Response(consentPage(details,handle,signedIn?.login,requiresWebsiteApproval(env)),{headers:consentHeaders(details.redirectUri)});
    }
    if (url.pathname==='/authorize' && request.method==='POST') {
      stage='consent-approval';
      if (request.headers.get('origin')!==settings.publicOrigin) return failure(403,'Consent origin denied');
      const form=await request.formData(); const handle=form.get('handle');
      if (typeof handle!=='string' || handle.length>512) return failure(400,'Invalid consent');
      if (form.get('decision')!=='approve') {
        const denied=await oauth.denyConsent(request,handle);
        return new Response(null,{status:302,headers:denied.headers});
      }
      const signedIn=await session(request,env).catch(()=>null);
      if(env.JAN_SITE_ROLE==='public'&&!signedIn)
        return /^[A-Za-z0-9_-]{43}$/.test(handle)?new Response(null,{status:303,headers:{Location:settings.publicOrigin+(env.PCRC_EMAIL_AUTH_ENABLED==='1'?'/devices/sign-in?consent=':'/devices/login?consent=')+handle,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}}):failure(400,'Invalid consent');
      // No form-controlled scope upgrade: retain the cookie-bound request scopes.
      const approved=await oauth.approveConsent(request,handle);
      requirePkce(approved.request,settings.resource);
      if(signedIn?.userId) {
        stage='authorization-complete';
        const {redirectTo}=await oauth.completeAuthorization({request:approved.request,userId:signedIn.userId,metadata:{label:'PC Remote Commander account'},scope:approved.request.scope,props:{accountId:signedIn.userId,authVersion:signedIn.authVersion??0,...confirmationProps(approved.request,hasControlScope(approved.request.scope)&&nativeConfirmationHost(approved.request.redirectUri)?await oauth.describeConsent(approved.request):undefined)}});
        chatGptCallbackEvidence(approved.request,redirectTo,settings.publicOrigin);
        approved.headers.set('Location',redirectTo);
        approved.headers.set('Referrer-Policy','no-referrer');
        return new Response(null,{status:303,headers:approved.headers});
      }
      const verifier=crypto.randomUUID()+crypto.randomUUID();
      stage='upstream-start';
      const upstream=await oauth.beginUpstream(approved.request,{data:{verifier},headers:approved.headers});
      const destination=new URL('https://github.com/login/oauth/authorize');
      destination.search=new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:settings.publicOrigin+'/callback',scope:'read:user',state:upstream.state,code_challenge:await s256(verifier),code_challenge_method:'S256'}).toString();
      // End the POST on this origin before leaving for GitHub. Some embedded
      // browsers retry a redirected form POST after the one-time consent has
      // already been consumed, leaving a misleading missing-cookie error.
      // A document navigation issues a GET, with a visible fallback link.
      const next=escaped(destination.href);
      const permissionLabel=hasControlScope(approved.request.scope)?'read and control':'read-only';
      const handoff='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0;url='+next+'"><title>Continue sign-in</title><style>'+portalStyles+'</style><main class="content center-card"><h1>Continue to GitHub</h1><section class="panel"><div class="panel-body"><p>Your '+permissionLabel+' request was accepted. Continue to GitHub to finish signing in.</p><a class="button primary" href="'+next+'">Continue to GitHub</a></div></section></main></html>';
      upstream.headers.set('Content-Type','text/html; charset=utf-8');
      upstream.headers.set('Referrer-Policy','no-referrer');
      upstream.headers.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
      upstream.headers.set('X-Frame-Options','DENY');
      return new Response(handoff,{status:200,headers:upstream.headers});
    }
    if (url.pathname==='/callback' && request.method==='GET') {
      stage='upstream-return';
      const recovered=await oauth.finishUpstream<{verifier:string}>(request);
      requirePkce(recovered.request,settings.resource);
      const code=url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length>512 || !recovered.data?.verifier) return failure(400,'Sign-in did not complete');
      stage='provider-exchange';
      const tokenResponse=await fetcher('https://github.com/login/oauth/access_token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,redirect_uri:settings.publicOrigin+'/callback',code,code_verifier:recovered.data.verifier})});
      if (!tokenResponse.ok) return failure(502,'Sign-in provider unavailable');
      const tokenData=await tokenResponse.json() as {access_token?:string};
      if (typeof tokenData.access_token!=='string' || tokenData.access_token.length>4096) return failure(400,'Sign-in failed');
      const userResponse=await fetcher('https://api.github.com/user',{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+tokenData.access_token,'Accept':'application/vnd.github+json','User-Agent':'JAN-MCP-Commander','X-GitHub-Api-Version':'2022-11-28'}});
      if (!userResponse.ok) return failure(502,'Sign-in provider unavailable');
      const user=await userResponse.json() as {id?:number};
      if (!Number.isSafeInteger(user.id) || !permittedAccount(String(user.id),env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS)) return failure(403,'This GitHub account is not permitted');
      // The GitHub token is only used for sign-in; never persist or forward it.
      stage='authorization-complete';
      const accountId=await resolveGitHubAccount(env,String(user.id));
      const {redirectTo}=await oauth.completeAuthorization({request:recovered.request,userId:accountId,metadata:{label:'PC Remote Commander account'},scope:recovered.request.scope,props:{...(accountId===String(user.id)?{githubId:accountId}:{accountId}),authVersion:env.DEVICES?(await deviceStore(env,'/account/auth-version',{},accountId)).authVersion:0,...confirmationProps(recovered.request,hasControlScope(recovered.request.scope)&&nativeConfirmationHost(recovered.request.redirectUri)?await oauth.describeConsent(recovered.request):undefined)}});
      chatGptCallbackEvidence(recovered.request,redirectTo,settings.publicOrigin);
      recovered.headers.set('Location',redirectTo);
      recovered.headers.set('Referrer-Policy','no-referrer');
      return new Response(null,{status:302,headers:recovered.headers});
    }
    if (url.pathname==='/' && request.method==='GET') return Response.json({name:'PC Remote Commander OAuth gateway',remote_origin_verified:false},{headers:{'Cache-Control':'no-store'}});
    return failure(404,'Not found');
  } catch (error) {
    // Do not reflect authorization requests, codes, credentials or stack traces.
    const description=error instanceof Error?error.message:'';
    const known:Record<string,[string,string]>={
      'This authorization was not started in this browser; start again':['AUTH_BROWSER_REQUIRED','Browser authorization cookie missing. Open the original authorization link and complete consent in the same browser.'],
      'This authorization belongs to a different browser session; start again':['AUTH_BROWSER_MISMATCH','Browser authorization does not match. Restart authorization in the same browser.'],
      'This authorization expired or was already used; start again':['AUTH_TRANSACTION_EXPIRED','This authorization expired or was already used. Restart from the original authorization link.'],
      'Invalid client_id':['AUTH_CLIENT_UNAVAILABLE','The authorization client is not available yet. Wait briefly and reopen the original authorization link.'],
    };
    const [code,message]=Object.hasOwn(known,description)?known[description]:['AUTH_INVALID_REQUEST','Authorization expired, invalid or unavailable; restart sign-in'];
    console.warn('PC_REMOTE_AUTH_REJECTED',JSON.stringify({stage,code}));
    if(request.headers.get('Accept')?.includes('text/html')&&['AUTH_BROWSER_REQUIRED','AUTH_BROWSER_MISMATCH','AUTH_TRANSACTION_EXPIRED'].includes(code))return restartConsentPage();
    return Response.json({error:message,code,stage},{status:400,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
}
