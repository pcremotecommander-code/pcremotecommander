import test from 'node:test';
import assert from 'node:assert/strict';
import {internalBillingHistory,loadBillingHistory,currentPayment,billingHistoryPage} from '../src/billing_history.ts';
import {deviceKey} from '../src/policy.ts';

const accountId='1234',subscription='sub_'+'a'.repeat(26),customer='ctm_'+'b'.repeat(26),transaction='txn_'+'c'.repeat(26);
function fixture(){
  const env={JAN_PROXY_KEY:'K'.repeat(43),ALLOWED_GITHUB_ID:accountId,JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'owner',PADDLE_ENVIRONMENT:'production',PADDLE_LIVE_ENABLED:'1',PADDLE_LIVE_API_KEY:'private-api-key',PADDLE_PRICE_ID:'pri_'+'a'.repeat(26)};
  env.DEVICES={idFromName:id=>id,get:()=>({fetch:async()=>Response.json([{id:subscription}])})};
  return env;
}
async function signed(env,body={accountId,after:null},timestamp=String(Math.floor(Date.now()/1000))){
  const raw=JSON.stringify(body);
  return new Request('https://pcrc-billing.internal/internal/billing/history',{method:'POST',headers:{'X-PCRC-Time':timestamp,'X-PCRC-Proof':await deviceKey(env.JAN_PROXY_KEY,'PCRC_BILLING_HISTORY_V1\n'+timestamp+'\n'+raw)},body:raw});
}
const entry=(changes={})=>({id:transaction,customer_id:customer,subscription_id:subscription,status:'completed',billed_at:'2026-10-30T00:00:00Z',currency_code:'INR',details:{totals:{total:'168449'}},...changes});

test('history verifies account ownership, filters every transaction and preserves original currencies',async()=>{
  const env=fixture(),calls=[];
  const provider=async(url,options)=>{
    calls.push(url);assert.equal(options.method,'GET');
    if(url.includes('/subscriptions/'))return Response.json({data:{id:subscription,status:'active',customer_id:customer,custom_data:{account_id:accountId}}});
    const query=new URL(url).searchParams;assert.equal(query.get('customer_id'),customer);assert.equal(query.get('subscription_id'),subscription);assert.equal(query.get('per_page'),'30');
    return Response.json({data:[entry(),entry({id:'txn_'+'d'.repeat(26),currency_code:'JPY',details:{totals:{total:'2400'}}}),entry({subscription_id:'sub_'+'e'.repeat(26)}),entry({customer_id:'ctm_'+'f'.repeat(26)})],meta:{pagination:{has_more:true}}});
  };
  const response=await internalBillingHistory(await signed(env),env,provider);
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const history=await response.json();assert.equal(history.rows.length,2);assert.equal(history.rows[0].amount,'₹1,684.49');assert.equal(history.rows[1].amount,'¥2,400');assert.equal(history.next,'txn_'+'d'.repeat(26));
  assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(history),/private-api-key|customer_id|account_id/);
});

test('history denies unsigned, stale, tampered or cross-account subscription requests',async()=>{
  const env=fixture();let calls=0;
  const provider=async()=>{calls++;return Response.json({data:{id:subscription,status:'active',customer_id:customer,custom_data:{account_id:'5678'}}});};
  assert.equal((await internalBillingHistory(new Request('https://owner/internal/billing/history',{method:'POST',body:'{}'}),env,provider)).status,403);
  assert.equal((await internalBillingHistory(await signed(env,undefined,'1000000000'),env,provider)).status,403);
  const tampered=await signed(env);tampered.headers.set('X-PCRC-Proof','A'.repeat(43));
  assert.equal((await internalBillingHistory(tampered,env,provider)).status,403);assert.equal(calls,0);
  assert.equal((await internalBillingHistory(await signed(env),env,provider)).status,502);assert.equal(calls,1);
  assert.equal((await internalBillingHistory(await signed(env),{...env,JAN_SITE_ROLE:'public'},provider)).status,403);
});

test('public billing bridge signs only the account-specific body and empty history makes no provider call',async()=>{
  const env=fixture();let captured;
  env.BILLING_SERVICE={fetch:async(url,options)=>{captured={url,options};return Response.json({rows:[],next:null});}};
  const publicEnv={...env,JAN_SITE_ROLE:'public'};
  assert.deepEqual(await loadBillingHistory(publicEnv,accountId),{rows:[],next:null});
  assert.deepEqual(JSON.parse(captured.options.body),{accountId,after:null});
  assert.equal(captured.url,'https://pcrc-billing.internal/internal/billing/history');
  assert.ok(captured.options.headers['X-PCRC-Proof']);
  await assert.rejects(()=>loadBillingHistory(publicEnv,accountId,'https://evil.invalid'),/cursor/);
  publicEnv.DEVICES={idFromName:id=>id,get:()=>({fetch:async()=>Response.json([])})};
  publicEnv.BILLING_SERVICE={fetch:()=>{throw Error('should not be called');}};
  assert.deepEqual(await loadBillingHistory(publicEnv,accountId),{rows:[],next:null});
});

test('only actual paid/completed transactions label the current month Paid; history groups months',async()=>{
  const now=Date.parse('2026-10-30T12:00:00Z');
  assert.equal(currentPayment({rows:[],next:null},now),'No confirmed payment this month');
  const row={id:transaction,at:'2026-10-01T00:00:00Z',status:'billed',amount:'$15.00'};
  assert.equal(currentPayment({rows:[row],next:null},now),'No confirmed payment this month');
  row.status='completed';assert.equal(currentPayment({rows:[row],next:null},now),'Paid');
  row.at='2026-09-30T23:59:59Z';assert.equal(currentPayment({rows:[row],next:null},now),'No confirmed payment this month');
  const html=await billingHistoryPage({rows:[row],next:transaction},{login:'test',csrf:'test'},{devices:[],calls:0,monthly:{used:0,limit:15000,resetsAt:now}}).text();
  assert.match(html,/September 2026/);assert.match(html,/Older transactions/);assert.match(html,/original transaction currency/);
});
