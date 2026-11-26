import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceDashboard} from '../src/portal_ui.ts';

test('post-approval dashboard checks immediately and reloads when delayed device registration arrives',async()=>{
  const html=await deviceDashboard({devices:[],calls:0,plan:'free',billing:[],monthly:{used:0,limit:15000,resetsAt:Date.now()+1000}},{login:'test',csrf:'synthetic'},'https://ui.example.workers.dev','approved',true).text();
  const javascript=[...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(item=>item[1]).find(item=>item.includes("getElementById('live-status')"));
  assert.ok(javascript);assert.match(html,/Beta\.49\.1 · Remote MCP/);assert.match(html,/Connection status updates automatically/);
  assert.match(html,/Prompt Library/);assert.match(html,/\/brand\/chatgpt.png/);assert.doesNotMatch(html,/>Cl<|aria-hidden="true">MCP/);
  const timers=new Map();let nextTimer=0,reads=0,reloads=0;const live={textContent:''};
  const document={hidden:false,body:{dataset:{deviceIds:''}},querySelectorAll:()=>[],getElementById:id=>id==='live-status'?live:null,querySelector:selector=>selector==='.dashboard-layout'?{dataset:{plan:'free',billingState:'[]'}}:null,addEventListener(){}};
  const location={search:'?notice=approved',reload(){reloads++;}};
  const setTimeout=(fn,delay)=>{timers.set(++nextTimer,{fn,delay});return nextTimer;};
  const clearTimeout=id=>timers.delete(id);
  const fetch=async()=>({ok:true,status:200,json:async()=>({plan:'free',billing:[],devices:++reads===1?[]:[{id:'new-device',revoked:false}],calls:0})});
  new Function('document','window','location','fetch','setTimeout','clearTimeout','AbortController','URLSearchParams',javascript)(document,{addEventListener(){}},location,fetch,setTimeout,clearTimeout,AbortController,URLSearchParams);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);assert.equal(reloads,0);
  const retry=[...timers.values()].find(timer=>timer.delay===2000);assert.ok(retry,'pairing waits at most two seconds for the agent import');
  await retry.fn();assert.equal(reloads,1);
});
