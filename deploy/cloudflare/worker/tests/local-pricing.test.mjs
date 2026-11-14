import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pricingConfiguration} from '../src/billing.ts';

const priceId='pri_'+'a'.repeat(26);
const env={JAN_SITE_ROLE:'public',PADDLE_ENVIRONMENT:'production',PADDLE_LIVE_ENABLED:'1',PADDLE_CLIENT_TOKEN:'live_'+'a'.repeat(27),PADDLE_WEBHOOK_SECRET:'private-webhook',JAN_PROXY_KEY:'private-signing-key',PADDLE_LIVE_API_KEY:'private-api-key',PADDLE_PRICE_ID:priceId};
test('public price configuration exposes only Paddle client metadata and fails closed',async()=>{
  const request=new Request('https://price.example/billing/pricing-config');
  const response=pricingConfiguration(request,env);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await response.json(),{environment:'production',token:env.PADDLE_CLIENT_TOKEN,priceId});
  for(const patch of [{PADDLE_LIVE_ENABLED:'0'},{PADDLE_WEBHOOK_SECRET:''},{PADDLE_CLIENT_TOKEN:'test_'+'a'.repeat(27)}])assert.equal(pricingConfiguration(request,{...env,...patch}).status,503);
  assert.equal(pricingConfiguration(request,{...env,JAN_SITE_ROLE:'owner'}).status,404);
  assert.equal(pricingConfiguration(new Request(request.url+'?currency=INR'),env).status,404);
});

const source=readFileSync(new URL('../public/pricing.js',import.meta.url),'utf8');
test('fresh Paddle localized totals render without exchange-rate math or a second checkout initialization',async()=>{
  for(const [amount,checkout] of [['₹1,684.49',true],['€17.85',false],['¥2,400',false]]){
    const price={textContent:'USD 15/month'},note={textContent:''};
    let ready,initializations=0,previews=0;
    const Paddle={Initialize(){initializations++;},PricePreview:async input=>{
      previews++;assert.deepEqual(JSON.parse(JSON.stringify(input)),{items:[{priceId,quantity:1}]});
      return {data:{details:{lineItems:[{price:{id:priceId},formattedTotals:{total:amount}}]}}};
    }};
    vm.runInNewContext(source,{window:{Paddle},Paddle,document:{querySelectorAll:selector=>selector==='[data-pro-price]'?[price]:[note],querySelector:()=>checkout?{}:null,addEventListener:(_event,handler)=>{ready=handler;}},fetch:async()=>({ok:true,json:async()=>({environment:'production',token:env.PADDLE_CLIENT_TOKEN,priceId})})});
    await ready();
    assert.equal(price.textContent,amount+'/month');
    assert.match(note.textContent,/including applicable tax/);
    assert.equal(initializations,checkout?0:1);
    assert.equal(previews,1);
  }
});

test('failed price preview keeps the labelled USD fallback',async()=>{
  let ready;
  const price={textContent:'USD 15/month'},note={textContent:''};
  vm.runInNewContext(source,{document:{querySelectorAll:selector=>selector==='[data-pro-price]'?[price]:[note],addEventListener:(_event,handler)=>{ready=handler;}},fetch:async()=>{throw Error('offline');}});
  await ready();
  assert.equal(price.textContent,'USD 15/month');assert.match(note.textContent,/Local price preview unavailable/);
});


test('home, pricing and billing use the shared localized quote rather than a hard-coded Pro amount',()=>{
  const home=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const pricing=readFileSync(new URL('../public/pricing/index.html',import.meta.url),'utf8');
  for(const page of [home,pricing]){
    assert.match(page,/data-pro-price/);
    assert.match(page,/data-price-note/);
    assert.match(page,/src="\/pricing\.js" defer/);
    assert.match(page,/script-src 'self' https:\/\/cdn\.paddle\.com/);
    assert.match(page,/connect-src 'self' https:\/\/\*\.paddle\.com/);
  }
  assert.doesNotMatch(home,/class="price">\$15|No live subscription is offered/);
});
