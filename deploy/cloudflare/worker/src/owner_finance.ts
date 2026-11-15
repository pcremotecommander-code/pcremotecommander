import {paddleRequest,billingApiReady} from './billing.ts';
import type {Settings} from './policy.ts';

export type OwnerStore=(path:string,data:unknown,accountId?:string)=>Promise<any>;
export type Revenue={month:string;after:string|null;complete:boolean;count:number;excluded:number;currencies:Record<string,{collected:number;adjustments:number;earnings:number|null}>;measuredAt:number};
const integer=(value:unknown)=>{if(typeof value!=='string'||! /^-?\d{1,15}$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Invalid payment amount');return Number(value);};
export function money(amount:number,currency:string):string{const f=new Intl.NumberFormat('en-US',{style:'currency',currency});return f.format(amount/10**(f.resolvedOptions().maximumFractionDigits??2));}
export function costAmount(value:string,currency:string):number{
  if(!/^[A-Z]{3}$/.test(currency)||!/^\d{1,12}(?:\.\d{1,3})?$/.test(value))throw Error('Enter a valid amount and currency');
  const decimals=new Intl.NumberFormat('en-US',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;
  const [whole,fraction='']=value.split('.');if(fraction.length>decimals)throw Error('Too many decimal places for this currency');
  const result=Number(whole)*10**decimals+Number(fraction.padEnd(decimals,'0'));if(!Number.isSafeInteger(result))throw Error('Amount exceeds limit');return result;
}
export async function refreshRevenue(env:Settings,store:OwnerStore,month:string,fetcher:typeof fetch=fetch,restart=false):Promise<Revenue>{
  if(!billingApiReady(env)||!/^20\d{2}-(?:0[1-9]|1[012])$/.test(month))throw Error('Billing API or month is unavailable');
  const old=await store('/owner-data/finance/get',{month});
  let state:Revenue=!restart&&old.revenue&&!old.revenue.complete?old.revenue:{month,after:null,complete:false,count:0,excluded:0,currencies:{},measuredAt:Date.now()};
  const start=new Date(month+'-01T00:00:00Z'),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  for(let page=0;page<4;page++){
    const query=new URLSearchParams({status:'completed',per_page:'30',include:'adjustments_totals',order_by:'created_at[ASC]','billed_at[GTE]':start.toISOString(),'billed_at[LT]':end.toISOString()});if(state.after)query.set('after',state.after);
    const response=await paddleRequest(env,'/transactions?'+query,'GET',undefined,fetcher) as {data?:any[];meta?:{pagination?:{has_more?:boolean}}};
    if(!Array.isArray(response.data)||response.data.length>30)throw Error('Invalid billing response');
    for(const t of response.data){
      if(!/^txn_[a-z0-9]{26}$/.test(t.id)||t.status!=='completed')throw Error('Invalid transaction record');
      if(!Array.isArray(t.items)||!t.items.length||!t.items.every((i:any)=>i.price?.id===env.PADDLE_PRICE_ID)){state.excluded++;continue;}
      const currency=t.currency_code;if(typeof currency!=='string'||! /^[A-Z]{3}$/.test(currency))throw Error('Invalid billing currency');
      const totals=t.details?.totals,adjustments=t.adjustments_totals;
      const row=state.currencies[currency]??={collected:0,adjustments:0,earnings:0};
      row.collected+=integer(totals?.total);row.adjustments+=adjustments?integer(adjustments.total):0;
      if(totals?.earnings===null||totals?.earnings===undefined||adjustments&&adjustments.earnings==null)row.earnings=null;
      else if(row.earnings!==null)row.earnings+=integer(totals.earnings)-(adjustments?integer(adjustments.earnings):0);
      if(!Number.isSafeInteger(row.collected)||!Number.isSafeInteger(row.adjustments)||row.earnings!==null&&!Number.isSafeInteger(row.earnings))throw Error('Billing amount exceeds limit');
      state.count++;
    }
    const next=response.meta?.pagination?.has_more===true;
    const cursor=response.data.at(-1)?.id;if(next&&(!cursor||cursor===state.after))throw Error('Billing cursor did not advance');
    state.after=next?cursor:null;state.complete=!next;state.measuredAt=Date.now();
    if(state.count+state.excluded>10000)throw Error('Monthly report limit exceeded');
    await store('/owner-data/finance/save',{month,revenue:state});if(state.complete)break;
  }
  return state;
}
