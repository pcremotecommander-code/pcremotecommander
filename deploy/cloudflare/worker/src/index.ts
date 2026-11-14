
import OAuthProvider,{getOAuthApi} from '@cloudflare/workers-oauth-provider';
import type {OAuthHelpers,OAuthResourceContext,OAuthProviderOptions} from '@cloudflare/workers-oauth-provider';
import {authorization} from './authorization.ts';
import {config,failure,proxyMcp,boundedBody,registerOrigin,registerDeviceOrigin,type Settings} from './policy.ts';
import {portal,maintainAccounts} from './device_portal.ts';
import {accountFromDeviceProof} from './account_identity.ts';
import {siteRouteAllowed} from './site_role.ts';
import {downloadPackage} from './package_download.ts';
import {verifiedSubscriptionEvent,pricingConfiguration} from './billing.ts';
import {deviceStore} from './device_portal.ts';
import {internalBillingHistory} from './billing_history.ts';
import {publicRateLimit} from './public_rate_limit.ts';
import {PUBLIC_SCOPES,SUPPORTED_SCOPES} from './oauth_scopes.ts';
export {JanDeviceStore} from './device_store.ts';
interface Env extends Settings {OAUTH_KV:KVNamespace;OAUTH_PROVIDER:OAuthHelpers;DEVICES:DurableObjectNamespace;PACKAGE_BUCKET?:R2Bucket;}
function oauthOptions(env:Env):OAuthProviderOptions<Env> {
  const settings=config(env);
  return {
    apiRoute:'/mcp',
    apiHandler:{async fetch(req,bindings,context) {
      const secured=context as OAuthResourceContext<{githubId?:string;accountId?:string;authVersion?:number}>;
      return proxyMcp(req,bindings,secured.auth,secured.props);
    }},
    defaultHandler:{fetch(req,bindings) {return authorization(req,bindings);}},
    authorizeEndpoint:'/authorize',tokenEndpoint:'/token',clientRegistrationEndpoint:'/register',
    // Scope aliases are enforced by proxyMcp so old and current grants both work.
    scopesSupported:SUPPORTED_SCOPES,requiredScopes:[],accessTokenTTL:900,
    refreshTokenTTL:2592000,refreshTokenIdleTTL:2592000,clientRegistrationTTL:7776000,allowTokenExchangeGrant:false,
    clientIdMetadataDocumentEnabled:true,
    resourceMetadata:{resource:settings.resource,authorization_servers:[settings.publicOrigin],resource_name:'PC Remote Commander workspace and optional computer control'},
  };
}

const counters=new Map<string,{count:number;expires:number}>();
function allowed(request:Request):boolean {
  const path=new URL(request.url).pathname;
  const key=(request.headers.get('cf-connecting-ip')??'unknown').slice(0,64)+'|'+path;
  const now=Date.now(); const old=counters.get(key);
  const item=old&&old.expires>now?old:{count:0,expires:now+60000};
  if (!counters.has(key)&&counters.size>=4096) counters.delete(counters.keys().next().value!);
  counters.set(key,item); item.count++;
  return item.count<=(['/register','/devices/login','/devices/claim','/devices/pair/start'].includes(path)?10:['/mcp','/devices/pair/proof'].includes(path)?120:60);
}
export default {
  async scheduled(_event:ScheduledController,env:Env):Promise<void> {
    if(env.JAN_SITE_ROLE!=='public'||env.JAN_MULTI_USER_ENABLED!=='1')return;
    try {
      const result=await maintainAccounts({...env,OAUTH_PROVIDER:getOAuthApi(oauthOptions(env),env)});
      await deviceStore(env,'/directory/maintenance-report',{success:true,...result});
      console.log('PCRC_ACCOUNT_MAINTENANCE',JSON.stringify(result));
    } catch {
      try {await deviceStore(env,'/directory/maintenance-report',{success:false});} catch {}
      console.error('PCRC_ACCOUNT_MAINTENANCE_FAILED');throw Error('Account maintenance failed');
    }
  },
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    let settings:ReturnType<typeof config>;
    try {
      settings = config(env);
    } catch {
      return failure(503, 'PC Remote Commander setup is incomplete');
    }
    if(new URL(request.url).pathname==='/internal/billing/history')return internalBillingHistory(request,env);
    if (new URL(request.url).origin!==settings.publicOrigin) return failure(403,'Origin denied');
    if (!['GET','POST','OPTIONS'].includes(request.method)) return failure(405,'Method denied');
    const path=new URL(request.url).pathname;
    if (/^\/mcp\/(?:perplexity|emergent)(?:\/index\.html|\/)?$/.test(path)) return failure(410, "This setup guide has been removed.");
    if(!siteRouteAllowed(env.JAN_SITE_ROLE,path,new URL(request.url).searchParams.get('state')?.startsWith('janportal.')===true))return failure(404,'Unavailable');
    const limited=path==='/mcp'?null:await publicRateLimit(request,env);
    if(limited)return limited;
    if (path!=='/mcp'&&!allowed(request)) return failure(429,'Rate limit reached');
    if(path==='/healthz'&&env.JAN_SITE_ROLE==='public') {
      if(request.method!=='GET'||new URL(request.url).search)return failure(400,'Invalid health request');
      try {
        const result=await env.DEVICES.get(env.DEVICES.idFromName('service:health:v1')).fetch('https://internal.invalid/health/check');
        if(result.status!==204)throw Error();
        return Response.json({service:'pcrc',status:'ok'},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      } catch {return failure(503,'Service unavailable');}
    }
    if(path==='/billing/paddle/webhook') {
      if(request.method!=='POST')return failure(405,'Method denied');
      try {
        const event=await verifiedSubscriptionEvent(request,env);
        if(event)await deviceStore(env,'/billing/subscription',event,event.accountId);
        return Response.json({received:true});
      } catch(error) {
        const reason=error instanceof Error&&['Billing unavailable','Invalid signature header','Expired signature','Signature mismatch','Webhook too large','Invalid subscription','Private device state rejected'].includes(error.message)?error.message:'Invalid payload';
        console.warn('PCRC_BILLING_WEBHOOK_REJECTED',reason);
        return failure(400,'Webhook denied');
      }
    }
    if(path==='/billing/pricing-config')return pricingConfiguration(request,env);
    if(path.startsWith('/downloads/'))return downloadPackage(request,env,ctx);
    // Device-initiated WebSocket: only signed, enrolled devices are admitted by the DO.
    // This route does not accept AI tool calls; those remain OAuth protected at /mcp.
    if(path==='/jan-relay/connect') {
      if(request.method!=='GET'||new URL(request.url).search) return failure(405,'Device connection denied');
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return failure(426,'WebSocket required');
      const proof=request.headers.get('X-JAN-Device-Proof');
      const accountId=accountFromDeviceProof(proof,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS);
      if(!accountId||!proof)return failure(403,'Device proof denied');
      const stub=env.DEVICES.get(env.DEVICES.idFromName(accountId));
      const headers=new Headers();
      headers.set('Upgrade','websocket');headers.set('Connection','Upgrade');headers.set('X-Jan-Account-Id',accountId);
      headers.set('X-JAN-Device-Proof',proof);
      if(request.headers.get('X-PCRC-Terminal-Status')==='1')headers.set('X-PCRC-Terminal-Status','1');
      try {return await stub.fetch('https://internal.invalid/relay/connect',{method:'GET',headers});}
      catch {return failure(503,'Device relay unavailable');}
    }
    if (path==='/jan-origin') {
      if (request.method!=='POST' || new URL(request.url).search) return failure(405,'Method denied');
      try {return await registerOrigin(request,env);} catch {return failure(503,'Registration unavailable');}
    }
    if(path==='/jan-device-origin') {
      if(request.method!=='POST'||new URL(request.url).search) return failure(405,'Method denied');
      try {return await registerDeviceOrigin(request,env);} catch {return failure(503,'Registration unavailable');}
    }
    // This library maps requiredScopes to scopes_supported. Advertise the full
    // supported catalogue independently; control is checked per tool.
    if (request.method==='GET' && ['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource'].includes(path)) {
      return Response.json({resource:settings.resource,authorization_servers:[settings.publicOrigin],
        scopes_supported:PUBLIC_SCOPES,bearer_methods_supported:['header'],
        resource_name:'PC Remote Commander workspace and optional computer control'},
        {headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if (request.method==='POST') {
      try {
        const body=await boundedBody(request,new URL(request.url).pathname==='/mcp'?262144:32768);
        request=new Request(request,{body:body as BodyInit});
      } catch {return failure(413,'Request too large');}
    }
    if(path==='/'||path==='/support'||path==='/admin'||path==='/admin/subscriptions'||path==='/admin/prompts'||path==='/admin/accounts'||path==='/library/prompts'||path.startsWith('/devices')||path==='/owner/login'||path==='/owner/logout'||(path==='/callback'&&new URL(request.url).searchParams.get('state')?.startsWith('janportal.'))) {
      return portal(request,path==='/devices/account/delete'?{...env,OAUTH_PROVIDER:getOAuthApi(oauthOptions(env),env)}:env);
    }
    const provider=new OAuthProvider<Env>(oauthOptions(env));
    try {
      const response=await provider.fetch(request,env,ctx);
      if(path==='/mcp'&&[401,403].includes(response.status)){
        const limited=await publicRateLimit(request,env);if(limited)return limited;
        if(!allowed(request))return failure(429,'Rate limit reached');
      }
      if(request.method==='GET'&&response.ok&&['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'].includes(path)){
        const metadata=await response.json() as Record<string,unknown>;
        return Response.json({...metadata,scopes_supported:PUBLIC_SCOPES},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      if (path==='/mcp' && response.status===401 && response.headers.has('WWW-Authenticate')) {
        const headers=new Headers(response.headers);
        // Preserve the provider's invalid-token signal so clients can refresh without new consent.
        const invalidToken=/(?:^|[,\s])error="invalid_token"(?:,|\s|$)/.test(response.headers.get('WWW-Authenticate')!);
        headers.set('WWW-Authenticate',`Bearer realm="OAuth", resource_metadata="${settings.publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="pcrc:read pcrc:control"${invalidToken?', error="invalid_token"':''}`);
        return new Response(response.body,{status:response.status,headers});
      }
      return response;
    } catch {return failure(503,'Authorization service unavailable');}
  },
};
