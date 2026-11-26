import type {Settings} from './policy.ts';
import {authenticatedAccountId} from './account_identity.ts';

// These entry budgets supplement account-level tool quotas; they never authorize access.
const budgets:Record<string,{minute:number;hour:number}>={
  emailAuthentication:{minute:10,hour:60},registration:{minute:10,hour:100},authentication:{minute:60,hour:600},
  pairing:{minute:10,hour:60},polling:{minute:120,hour:1800},
  token:{minute:60,hour:600},relay:{minute:30,hour:300},mcp:{minute:120,hour:6000},
};
type Window={recent:number[];hourStart:number;hourCount:number;expiresAt:number};
const deny=(status:number,retry:number)=>Response.json({error:status===429?'Too many requests. Wait and retry.':'Request protection temporarily unavailable. Try again shortly.'},{status,headers:{'Retry-After':String(retry),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function bucket(path:string):string|null {
  if(path==='/devices/email/verification-status')return 'polling';
  if(path.startsWith('/devices/github/'))return 'authentication';
  if(path.startsWith('/devices/email/'))return 'emailAuthentication';
  if(path==='/devices/sign-in')return 'authentication';
  if(path==='/register')return 'registration';
  if(['/authorize','/callback','/consent','/devices/login','/owner/login'].includes(path))return 'authentication';
  if(['/devices/pair/start','/devices/claim'].includes(path))return 'pairing';
  if(['/devices/pair/poll','/devices/pair/proof'].includes(path))return 'polling';
  if(path==='/token')return 'token';
  if(path==='/jan-relay/connect'||path==='/device-transfer/verify')return 'relay';
  if(path==='/mcp')return 'mcp';
  return null;
}
export async function publicRateLimit(request:Request,env:Settings):Promise<Response|null> {
  const group=bucket(new URL(request.url).pathname);
  if(!group)return null;
  // Cloudflare overwrites this header at the edge. Never trust X-Forwarded-For.
  const ip=request.headers.get('CF-Connecting-IP')?.slice(0,64)??'unknown';
  return enforceBudget(group,'ip:'+ip,env);
}
/** Call only with the canonical identity from a verified OAuth resource context. */
export async function authenticatedMcpRateLimit(accountId:string,env:Settings):Promise<Response|null> {
  if(!authenticatedAccountId(accountId))return deny(403,10);
  return enforceBudget('mcp','account:'+accountId,env);
}
async function enforceBudget(group:string,principal:string,env:Settings):Promise<Response|null> {
  try {
    if(!env.DEVICES)throw Error();
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.JAN_PROXY_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(['PCRC_ABUSE_V1',env.JAN_PUBLIC_ORIGIN,group,principal].join('\n')));
    const id=Array.from(new Uint8Array(mac),b=>b.toString(16).padStart(2,'0')).join('');
    const result=await env.DEVICES.get(env.DEVICES.idFromName('abuse:v1:'+id)).fetch('https://internal.invalid/abuse/check',{method:'POST',body:JSON.stringify({bucket:group})});
    if(result.status===204)return null;
    const retry=Number(result.headers.get('Retry-After'));
    if(result.status===429&&Number.isInteger(retry)&&retry>=1&&retry<=3600)return deny(429,retry);
  } catch(error) {
    const candidate=error instanceof Error?error.name:'UnknownError';
    const errorName=/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate)?candidate:'UnknownError';
    console.error('PCRC_ABUSE_LIMITER_UNAVAILABLE',{errorName});
  }
  return deny(503,10);
}
export async function consumePublicBudget(request:Request,storage:DurableObjectStorage):Promise<Response> {
  if(request.method!=='POST')return new Response(null,{status:405});
  let group:unknown;
  try {
    const raw=await request.text();
    if(raw.length>80)throw Error();
    const body=JSON.parse(raw);
    if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='bucket')throw Error();
    group=body.bucket;
  } catch {return new Response(null,{status:400});}
  if(typeof group!=='string'||!Object.hasOwn(budgets,group))return new Response(null,{status:400});
  const limits=budgets[group],now=Date.now();
  return storage.transaction(async tx=>{
    const old=await tx.get<Window>('abuse:v1');
    const window:Window=old&&old.hourStart+3600000>now?old:{recent:old?.recent??[],hourStart:now,hourCount:0,expiresAt:now+3660000};
    window.recent=window.recent.filter(at=>at>now-60000);
    if(window.recent.length>=limits.minute||window.hourCount>=limits.hour) {
      const until=window.hourCount>=limits.hour?window.hourStart+3600000:window.recent[0]+60000;
      return deny(429,Math.max(1,Math.ceil((until-now)/1000)));
    }
    window.recent.push(now);window.hourCount++;
    await tx.put('abuse:v1',window);
    await tx.setAlarm(window.expiresAt);
    return new Response(null,{status:204});
  });
}
export async function expirePublicBudget(storage:DurableObjectStorage):Promise<void> {
  await storage.transaction(async tx=>{
    const item=await tx.get<Window>('abuse:v1');
    if(item&&item.expiresAt>Date.now())await tx.setAlarm(item.expiresAt);
    else await tx.delete('abuse:v1');
  });
}
