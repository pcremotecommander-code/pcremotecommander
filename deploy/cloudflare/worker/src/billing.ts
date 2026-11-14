import {authenticatedAccountId} from './account_identity.ts';
import {boundedBody,type Settings} from './policy.ts';

const encoder=new TextEncoder();
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function mac(secret:string,value:string) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));
}
function same(a:string,b:string) {
  if(a.length!==b.length)return false;
  let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);
  return difference===0;
}
export const liveBilling=(env:Settings)=>env.PADDLE_ENVIRONMENT==='production'&&env.PADDLE_LIVE_ENABLED==='1';
export const billingReady=(env:Settings)=>env.JAN_SITE_ROLE==='public'&&
  (env.PADDLE_ENVIRONMENT==='production'?liveBilling(env)&&/^live_[A-Za-z0-9]{27}$/.test(env.PADDLE_CLIENT_TOKEN??''):
    (env.PADDLE_ENVIRONMENT===undefined||env.PADDLE_ENVIRONMENT==='sandbox')&&/^test_[A-Za-z0-9]{27}$/.test(env.PADDLE_CLIENT_TOKEN??''))&&!!env.PADDLE_WEBHOOK_SECRET&&/^pri_[a-z0-9]{26}$/.test(env.PADDLE_PRICE_ID??'');
export const sandboxBillingReady=(env:Settings)=>env.PADDLE_ENVIRONMENT!=='production'&&billingReady(env);
export function pricingConfiguration(request:Request,env:Settings):Response {
  if(request.method!=='GET'||new URL(request.url).search||env.JAN_SITE_ROLE!=='public')return new Response(null,{status:404});
  if(!billingReady(env))return new Response(null,{status:503,headers:{'Cache-Control':'no-store'}});
  // Client-side tokens are public Paddle.js identifiers; never return API or signing keys.
  return Response.json({environment:env.PADDLE_ENVIRONMENT??'sandbox',token:env.PADDLE_CLIENT_TOKEN,priceId:env.PADDLE_PRICE_ID},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export const billingApiReady=(env:Settings)=>env.PADDLE_ENVIRONMENT==='production'?liveBilling(env)&&!!env.PADDLE_LIVE_API_KEY:(env.PADDLE_ENVIRONMENT===undefined||env.PADDLE_ENVIRONMENT==='sandbox')&&!!env.PADDLE_SANDBOX_API_KEY;
export async function checkoutBinding(env:Settings,accountId:string) {
  return mac(env.JAN_PROXY_KEY,(env.PADDLE_ENVIRONMENT==='production'?'PCRC_PADDLE_CHECKOUT_LIVE_V1':'PCRC_PADDLE_CHECKOUT_V1')+'\n'+accountId+'\n'+env.PADDLE_PRICE_ID);
}
export type SubscriptionEvent={accountId:string;id:string;eventId:string;occurredAt:number;status:string;priceId:string;cancelAt:string|null};
export async function verifiedSubscriptionEvent(request:Request,env:Settings):Promise<SubscriptionEvent|null> {
  if(!billingReady(env))throw Error('Billing unavailable');
  const signature=request.headers.get('Paddle-Signature')??'';
  const ts=/^ts=(\d{10});h1=([a-f0-9]{64})(?:;h1=[a-f0-9]{64})*$/.exec(signature);
  if(!ts)throw Error('Invalid signature header');
  if(Math.abs(Date.now()/1000-Number(ts[1]))>30)throw Error('Expired signature');
  const raw=new TextDecoder().decode(await boundedBody(request,32768));
  if(!same(await mac(env.PADDLE_WEBHOOK_SECRET!,ts[1]+':'+raw),ts[2]))throw Error('Signature mismatch');
  const event=JSON.parse(raw) as {event_id?:unknown;event_type?:unknown;occurred_at?:unknown;data?:{id?:unknown;status?:unknown;items?:{price?:{id?:unknown}}[];scheduled_change?:{action?:unknown;effective_at?:unknown}|null;custom_data?:{account_id?:unknown;account_binding?:unknown}}};
  if(typeof event.event_type!=='string'||!event.event_type.startsWith('subscription.'))return null;
  const data=event.data,accountId=authenticatedAccountId(data?.custom_data?.account_id),priceId=env.PADDLE_PRICE_ID!;
  const occurredAt=Date.parse(String(event.occurred_at));
  if(!accountId||typeof data?.custom_data?.account_binding!=='string'||
    !same(data.custom_data.account_binding,await checkoutBinding(env,accountId))||
    typeof data.id!=='string'||!/^sub_[a-z0-9]{26}$/.test(data.id)||
    typeof event.event_id!=='string'||!/^evt_[a-z0-9]{26}$/.test(event.event_id)||
    !Number.isFinite(occurredAt)||occurredAt>Date.now()+300000||
    typeof data.status!=='string'||!Array.isArray(data.items))throw Error('Invalid subscription');
  const cancelAt=data.scheduled_change?.action==='cancel'&&typeof data.scheduled_change.effective_at==='string'&&Number.isFinite(Date.parse(data.scheduled_change.effective_at))?data.scheduled_change.effective_at:null;
  return {accountId,id:data.id,eventId:event.event_id,occurredAt,status:data.status,priceId:data.items.some(item=>item.price?.id===priceId)?priceId:'none',cancelAt};
}

export type PaddleSubscription={id:string;status:string;scheduled_change?:{action:string;effective_at:string}|null;custom_data?:{account_id?:string}};
export async function paddleRequest(env:Settings,path:string,method='GET',body?:object,fetcher:typeof fetch=fetch):Promise<any> {
  if(env.JAN_SITE_ROLE!=='owner'||!billingApiReady(env))throw Error(env.PADDLE_ENVIRONMENT==='production'?'Paddle live API key and explicit live enablement are required on the owner Worker':'Paddle sandbox API key is not configured on the owner Worker');
  const live=env.PADDLE_ENVIRONMENT==='production';
  const response=await fetcher((live?'https://api.paddle.com':'https://sandbox-api.paddle.com')+path,{method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+(live?env.PADDLE_LIVE_API_KEY:env.PADDLE_SANDBOX_API_KEY),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error('Paddle rejected this request ('+response.status+'). Check the subscription, API permissions, and Paddle dashboard.');
  return response.json();
}
export async function paddleSubscription(env:Settings,id:string,fetcher:typeof fetch=fetch):Promise<PaddleSubscription> {
  if(!/^sub_[a-z0-9]{26}$/.test(id))throw Error('Invalid subscription ID');
  const item=(await paddleRequest(env,'/subscriptions/'+id,'GET',undefined,fetcher)).data as PaddleSubscription;
  if(item?.id!==id||!['active','canceled','past_due','paused','trialing'].includes(item.status))throw Error('Paddle returned an unexpected subscription');
  return item;
}
export async function refundableTransaction(env:Settings,subscriptionId:string,fetcher:typeof fetch=fetch):Promise<string|null> {
  const result=await paddleRequest(env,'/transactions?subscription_id='+subscriptionId+'&status=completed&per_page=30&order_by=created_at%5BDESC%5D','GET',undefined,fetcher) as {data?:{id?:string;status?:string}[]};
  const transaction=result.data?.find(item=>item.status==='completed'&&/^txn_[a-z0-9]{26}$/.test(item.id??''));
  if(!transaction)return null;
  const adjustments=await paddleRequest(env,'/adjustments?transaction_id='+transaction.id+'&action=refund&per_page=50','GET',undefined,fetcher) as {data?:{status?:string}[];meta?:{pagination?:{has_more?:boolean}}};
  if(!Array.isArray(adjustments.data)||adjustments.meta?.pagination?.has_more!==false||adjustments.data.some(item=>item.status!=='rejected'))return null;
  return transaction.id!;
}
export async function cancelPaddleSubscription(env:Settings,id:string,immediate:boolean,fetcher:typeof fetch=fetch):Promise<PaddleSubscription> {
  const item=(await paddleRequest(env,'/subscriptions/'+id+'/cancel','POST',{effective_from:immediate?'immediately':'next_billing_period'},fetcher)).data as PaddleSubscription;
  if(item?.id!==id)throw Error('Paddle returned an unexpected cancellation');
  return item;
}
export async function refundPaddleTransaction(env:Settings,transactionId:string,reason:string,fetcher:typeof fetch=fetch):Promise<{id:string;status:string}> {
  if(!/^txn_[a-z0-9]{26}$/.test(transactionId)||!reason.trim()||reason.length>200)throw Error('Invalid refund request');
  const item=(await paddleRequest(env,'/adjustments','POST',{action:'refund',type:'full',transaction_id:transactionId,reason:reason.trim()},fetcher)).data as {id:string;status:string};
  if(!/^adj_[a-z0-9]{26}$/.test(item?.id??''))throw Error('Paddle returned an unexpected refund');
  return {id:item.id,status:item.status};
}
