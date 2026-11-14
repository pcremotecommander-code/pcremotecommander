// Explicit opt-in local benchmark; excluded from npm test and production builds.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

const target=Number(process.argv[2]??200);
assert.ok(Number.isInteger(target)&&target>=1&&target<=200);
const base='https://local-capacity.example.workers.dev',master='A'.repeat(43);
const bundled=await build({entryPoints:[new URL('./local-capacity.entry.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022'});
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'local-capacity',modules:true,script:bundled.outputFiles[0].text,
  compatibilityDate:'2026-10-15',durableObjects:{DEVICES:{className:'LocalFixtureStore',useSQLite:true}},
  bindings:{JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:master,
    GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',
    JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1'},
  outboundService:async()=>{throw Error('All external HTTP is disabled for this local benchmark');}}]}));
const clients=[],rounds=[];let replyErrors=0;
const report={local_only:true,paid_usage:false,target,oauth_login_measured:false,real_device_execution:false,
  workload:'real workerd + SQLite Durable Objects + signed synthetic WebSocket devices; post-authentication MCP status calls',
  rounds,passed:false};
async function upgrade(account,device){
  const timestamp=Math.floor(Date.now()/1000),nonce=randomBytes(24).toString('base64url');
  const key=createHmac('sha256',master).update('JAN_DEVICE_KEY_V1\n'+device).digest('base64url');
  const signature=createHmac('sha256',key).update(['JAN_RELAY_WS_V1',account,device,String(timestamp),nonce].join('\n')).digest('hex');
  const ns=await mf.getDurableObjectNamespace('DEVICES','local-capacity');
  return ns.get(ns.idFromName(account)).fetch('https://internal.invalid/relay/connect',
    {headers:{Upgrade:'websocket',Connection:'Upgrade','X-Jan-Account-Id':account,
    'X-JAN-Device-Proof':JSON.stringify({device_id:device,owner_id:account,timestamp,nonce,signature})}});
}
const extraSockets=[];
function resources(){
  const freeMB=Math.round(freemem()/1024/1024);
  assert.ok(freeMB>=768,'Local free memory below 768 MiB; stopped before increasing load');return freeMB;
}
async function parallel(values,limit,fn){
  let next=0;await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{
    while(next<values.length){const index=next++;await fn(values[index],index);}
  }));
}
try{
  await mf.ready;const ns=await mf.getDurableObjectNamespace('DEVICES','local-capacity');
  for(const stage of [...new Set([Math.min(50,target),Math.min(200,target),Math.min(500,target),target])]){
    resources();const started=performance.now();
    await parallel(Array.from({length:stage-clients.length},(_,i)=>String(5000+clients.length+i)),25,async account=>{
      const device=randomUUID(),stub=ns.get(ns.idFromName(account));
      const seeded=await stub.fetch('https://fixture.invalid/fixture/seed',{method:'POST',body:JSON.stringify({account,device})});
      assert.equal(seeded.status,204);
      const timestamp=Math.floor(Date.now()/1000),nonce=randomBytes(24).toString('base64url');
      const key=createHmac('sha256',master).update('JAN_DEVICE_KEY_V1\n'+device).digest('base64url');
      const signature=createHmac('sha256',key).update(['JAN_RELAY_WS_V1',account,device,String(timestamp),nonce].join('\n')).digest('hex');
      const upgrade=await stub.fetch('https://internal.invalid/relay/connect',{headers:{Upgrade:'websocket',Connection:'Upgrade',
        'X-Jan-Account-Id':account,'X-JAN-Device-Proof':JSON.stringify({device_id:device,owner_id:account,timestamp,nonce,signature})}});
      assert.equal(upgrade.status,101);const socket=upgrade.webSocket;socket.accept();
      socket.addEventListener('message',event=>{
        try{
          const envelope=JSON.parse(event.data),call=JSON.parse(envelope.payload);
          socket.send(JSON.stringify({type:'response',request_id:envelope.request_id,status:200,
            payload:JSON.stringify({jsonrpc:'2.0',id:call.id,result:{account,marker:'PCRC_SYNTHETIC_STATUS'}})}));
        }catch{replyErrors++;}
      });clients.push({account,device,socket});
    });
    if(stage===target&&target===200){
      const coordinator=ns.get(ns.idFromName('service:connected-capacity:v1'));
      const expiry=async()=>(await coordinator.fetch('https://fixture.invalid/fixture/lease-expiries')).json();
      const initial=await expiry();
      assert.equal(Object.keys(initial).length,200);
      console.log('Checking persisted renewal timestamps across 200 accounts');
      await new Promise(resolve=>setTimeout(resolve,43000));
      const renewed=await expiry();
      assert.equal(Object.keys(renewed).length,200);
      assert.ok(Object.entries(initial).every(([account,expires])=>renewed[account]-expires>=39000),
        'Every account must renew its shared lease twice');
      report.renewal_cycles_exercised=2;
      report.accounts_with_two_persisted_renewals=200;
    }
    const latencies=[];let errors=0;const runStarted=performance.now();
    await Promise.all(clients.map(async({account})=>{
      const at=performance.now();
      try{
        const response=await mf.dispatchFetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',
          'X-Test-Account':account,'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_connection_status',arguments:{}}})});
        assert.equal(response.status,200);const body=await response.json();
        assert.equal(body.result.account,account,'Account isolation failed');
        assert.equal(body.result.marker,'PCRC_SYNTHETIC_STATUS');
      }catch{errors++;}
      latencies.push(performance.now()-at);
    }));
    latencies.sort((a,b)=>a-b);const seconds=(performance.now()-runStarted)/1000;
    const result={connected_clients:clients.length,concurrency:clients.length,requests:latencies.length,errors,
      p50_ms:Math.round(latencies[Math.floor(latencies.length*.5)]),p95_ms:Math.round(latencies[Math.min(latencies.length-1,Math.floor(latencies.length*.95))]),
      max_ms:Math.round(latencies.at(-1)),requests_per_second:Number((latencies.length/seconds).toFixed(1)),
      setup_seconds:Number(((runStarted-started)/1000).toFixed(1)),free_memory_mb:resources()};
    rounds.push(result);console.log(JSON.stringify(result));
    assert.equal(errors,0);assert.equal(replyErrors,0);
  }
  if(target===200){
    const first=clients[0];
    const replacement=await upgrade(first.account,first.device);assert.equal(replacement.status,101);
    replacement.webSocket.accept();extraSockets.push(replacement.webSocket);
    const other=randomUUID(),stub=ns.get(ns.idFromName(first.account));
    await stub.fetch('https://fixture.invalid/fixture/seed',{method:'POST',body:JSON.stringify({account:first.account,device:other})});
    const second=await upgrade(first.account,other);assert.equal(second.status,101);
    second.webSocket.accept();extraSockets.push(second.webSocket);report.reconnect_and_multiple_devices_share_slot=true;
    const account='9000',device=randomUUID(),overflow=ns.get(ns.idFromName(account));
    await overflow.fetch('https://fixture.invalid/fixture/seed',{method:'POST',body:JSON.stringify({account,device})});
    assert.equal((await upgrade(account,device)).status,429);report.account_201_denied=true;
    replacement.webSocket.close();await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal((await upgrade(account,device)).status,429,'One of two devices disconnecting must not release the account slot');
    second.webSocket.close();
    for(let attempt=0;attempt<20;attempt++){
      await new Promise(resolve=>setTimeout(resolve,100));const response=await upgrade(account,device);
      if(response.status===101){response.webSocket.accept();extraSockets.push(response.webSocket);report.slot_released_after_last_device=true;break;}
      assert.equal(response.status,429);
    }
    assert.equal(report.slot_released_after_last_device,true);
  }
  report.passed=clients.length===target;
}catch(error){report.error=error instanceof Error?error.message:'Local benchmark failed';process.exitCode=1;}
finally{
  report.connected_clients=clients.length;
  for(const socket of extraSockets)try{socket.close();}catch{}
  for(const {socket}of clients)try{socket.close();}catch{}
  await mf.dispose();writeFileSync(new URL('../../../../work/local-capacity-200-result.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,local_only:true,connected_clients:clients.length,error:report.error}));
}
