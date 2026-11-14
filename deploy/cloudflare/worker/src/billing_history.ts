import {deviceKey,escaped,boundedBody} from './policy.ts';
import {permittedAccount} from './account_identity.ts';
import {paddleRequest,paddleSubscription} from './billing.ts';
import {deviceStore,type DeviceEnv} from './device_portal.ts';
import {portalPage,pageHeading,type PortalOwner,type PortalData} from './portal_ui.ts';

export type BillingHistory={rows:{id:string;at:string;status:string;amount:string}[];next:string|null};
const transactionId=(value:unknown):value is string=>typeof value==='string'&&/^txn_[a-z0-9]{26}$/.test(value);
const historyProof=(key:string,timestamp:string,body:string)=>deviceKey(key,'PCRC_BILLING_HISTORY_V1\n'+timestamp+'\n'+body);

export async function loadBillingHistory(env:DeviceEnv,accountId:string,after:string|null=null):Promise<BillingHistory> {
  if(!permittedAccount(accountId,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS)||after!==null&&!transactionId(after))throw Error('Invalid billing account or cursor');
  const subscriptions=await deviceStore(env,'/billing/summary',{},accountId) as {id:string}[];
  if(!subscriptions.length)return {rows:[],next:null};
  if(!env.BILLING_SERVICE)throw Error('Billing history is temporarily unavailable');
  const body=JSON.stringify({accountId,after}),timestamp=String(Math.floor(Date.now()/1000));
  const response=await env.BILLING_SERVICE.fetch('https://pcrc-billing.internal/internal/billing/history',{method:'POST',headers:{'Content-Type':'application/json','X-PCRC-Time':timestamp,'X-PCRC-Proof':await historyProof(env.JAN_PROXY_KEY,timestamp,body)},body,signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('Billing history is temporarily unavailable');
  return response.json();
}

/** Read-only service call: exact account/body signed by the authenticated public portal. */
export async function internalBillingHistory(request:Request,env:DeviceEnv,fetcher:typeof fetch=fetch):Promise<Response> {
  const denied=()=>new Response(null,{status:403,headers:{'Cache-Control':'no-store'}});
  if(env.JAN_SITE_ROLE!=='owner'||request.method!=='POST')return denied();
  const timestamp=request.headers.get('X-PCRC-Time')??'',signature=request.headers.get('X-PCRC-Proof')??'';
  if(!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>30||!/^[A-Za-z0-9_-]{43}$/.test(signature))return denied();
  let raw:string;try {raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await boundedBody(request,512));} catch {return denied();}
  const expected=await historyProof(env.JAN_PROXY_KEY,timestamp,raw);
  let difference=0;for(let i=0;i<43;i++)difference|=signature.charCodeAt(i)^expected.charCodeAt(i);if(difference)return denied();
  try {
    const input=JSON.parse(raw) as {accountId?:string;after?:string|null};
    const accountId=permittedAccount(input.accountId,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS);
    if(!accountId||input.after!==null&&!transactionId(input.after))return denied();
    const subscriptions=await deviceStore(env,'/billing/summary',{},accountId) as {id:string}[];
    if(subscriptions.length>20)throw Error('Billing subscription limit');
    const customers=new Set<string>(),ids=new Set<string>();
    for(const stored of subscriptions){
      const subscription=await paddleSubscription(env,stored.id,fetcher) as {id:string;customer_id?:string;custom_data?:{account_id?:string}};
      if(subscription.custom_data?.account_id!==accountId||!/^ctm_[a-z0-9]{26}$/.test(subscription.customer_id??''))throw Error('Billing ownership mismatch');
      customers.add(subscription.customer_id!);ids.add(subscription.id);
    }
    if(!customers.size)return Response.json({rows:[],next:null},{headers:{'Cache-Control':'no-store'}});
    const query=new URLSearchParams({customer_id:[...customers].join(','),subscription_id:[...ids].join(','),per_page:'30',order_by:'created_at[DESC]'});
    if(input.after)query.set('after',input.after);
    const result=await paddleRequest(env,'/transactions?'+query,'GET',undefined,fetcher) as {data?:any[];meta?:{pagination?:{has_more?:boolean}}};
    if(!Array.isArray(result.data)||result.data.length>30)throw Error('Invalid billing response');
    const rows:BillingHistory['rows']=[];
    for(const item of result.data){
      // A shared payer/customer must never expose another PCRC account's subscription.
      if(!ids.has(item.subscription_id)||!customers.has(item.customer_id)||!transactionId(item.id))continue;
      if(!['draft','ready','billed','paid','completed','past_due','canceled'].includes(item.status))continue;
      const at=Date.parse(item.billed_at??item.created_at),total=item.details?.totals?.total,currency=item.currency_code;
      if(!Number.isFinite(at)||typeof total!=='string'||!/^\d{1,15}$/.test(total)||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))continue;
      const format=new Intl.NumberFormat('en-US',{style:'currency',currency});
      const decimals=format.resolvedOptions().maximumFractionDigits;
      if(decimals===undefined)throw Error('Unsupported billing currency');
      rows.push({id:item.id,at:new Date(at).toISOString(),status:item.status,amount:format.format(Number(total)/10**decimals)});
    }
    const last=rows.at(-1)?.id;
    return Response.json({rows,next:result.meta?.pagination?.has_more&&transactionId(last)?last:null},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  } catch {return new Response(null,{status:502,headers:{'Cache-Control':'no-store'}});}
}

export const billingMonth=(now=Date.now())=>new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(now);
export function currentPayment(history:BillingHistory,now=Date.now()):string {
  const month=new Date(now).toISOString().slice(0,7);
  return history.rows.some(row=>row.at.startsWith(month)&&['paid','completed'].includes(row.status))?'Paid':'No confirmed payment this month';
}
export function billingHistoryPage(history:BillingHistory|null,owner:PortalOwner,data:PortalData):Response {
  let previousMonth='';
  const rows=(history?.rows??[]).map(item=>{
    const month=billingMonth(Date.parse(item.at)),heading=month!==previousMonth?'<h2>'+escaped(month)+'</h2>':'';previousMonth=month;
    return heading+'<div class="setting"><div><strong>'+escaped(item.amount)+'</strong><p>'+escaped(new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'UTC'}).format(Date.parse(item.at)))+' · '+escaped(item.id)+'</p></div><span class="badge '+(['paid','completed'].includes(item.status)?'online':'read')+'">'+escaped(['paid','completed'].includes(item.status)?'Paid':item.status.replaceAll('_',' '))+'</span></div>';
  }).join('');
  return portalPage('<a class="back-link" href="/devices/plan">Back to plan & billing</a>'+pageHeading('Billing history','Your Paddle subscription payments, grouped by month. Amounts keep the original transaction currency.')+'<section class="panel"><div class="panel-body">'+(history?rows||'<h2>No billing records yet</h2><p>No confirmed subscription transactions are recorded for this account. Free usage does not create an invoice.</p>':'<h2>Billing history is temporarily unavailable</h2><p>Try again shortly or contact support. Your subscription has not been changed.</p>')+'</div></section>'+(history?.next?'<a class="button neutral" href="/devices/billing/history?after='+escaped(history.next)+'">Older transactions</a>':''),'Billing history',{owner,data,active:'plan'});
}
