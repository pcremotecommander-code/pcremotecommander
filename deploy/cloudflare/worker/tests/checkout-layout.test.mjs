import test from 'node:test';
import assert from 'node:assert/strict';
import {portalPage} from '../src/portal_ui.ts';

test('sandbox and live checkout use one-page overlay defaults without changing account or price binding',async()=>{
  for(const environment of ['sandbox','production']) {
    const priceId='pri_'+'a'.repeat(26),accountId='1234',binding='synthetic-binding';
    const page=portalPage('<button id="pro-checkout">Upgrade</button>','Plan',{checkout:{environment,token:(environment==='production'?'live_':'test_')+'a'.repeat(27),priceId,accountId,binding}});
    const html=await page.text();
    const nonce=/'nonce-([^']+)'/.exec(page.headers.get('Content-Security-Policy'))?.[1];
    assert.ok(nonce);
    assert.ok(html.includes(`<script nonce="${nonce}" src="/pricing.js" defer>`),'local pricing script must satisfy the dashboard CSP');
    const scripts=[...html.matchAll(/<script(?: data-pcrc-checkout)? nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(match=>match[1]);
    let initialized,click,opened,sandboxCalls=0;
    const Paddle={Environment:{set(value){assert.equal(value,'sandbox');sandboxCalls++;}},Initialize(value){initialized=value;},Checkout:{open(value){opened=value;}}};
    const document={getElementById(id){assert.equal(id,'pro-checkout');return {addEventListener(event,handler){assert.equal(event,'click');click=handler;}};}};
    new Function('Paddle','document',scripts.at(-1))(Paddle,document);
    assert.deepEqual(initialized.checkout?.settings,{displayMode:'overlay',variant:'one-page'});
    assert.equal(sandboxCalls,environment==='sandbox'?1:0);
    click();
    assert.deepEqual(opened.items,[{priceId,quantity:1}]);
    assert.deepEqual(opened.customData,{account_id:accountId,account_binding:binding});
    assert.equal(typeof initialized.eventCallback,'function','webhook-confirmation UX stays attached');
  }
});
