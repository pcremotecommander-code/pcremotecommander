import test from 'node:test';
import assert from 'node:assert/strict';
import {JanRelaySession} from '../src/relay_session.ts';
const rid='c3e35d88-9749-4af8-8c13-0d097e89f77b';
class Socket extends EventTarget {
  readyState=1; sent=[];
  send(v){this.sent.push(v);}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  receive(v){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(v)}));}
}
const request=()=>({type:'request',request_id:rid,control:false,payload:JSON.stringify({jsonrpc:'2.0',method:'ping',id:1})});
const reply=()=>({type:'response',request_id:rid,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{}})});
test('relay resolves matching authenticated-session response',async()=>{
  const s=new JanRelaySession(),ws=new Socket();s.attach(ws);
  const pending=s.forward(request());
  assert.equal(ws.sent.length,1);
  ws.receive(reply());
  assert.equal((await pending).status,200);
  s.close();
});
test('relay disconnect rejects outstanding calls and blocks reuse',async()=>{
  const s=new JanRelaySession(),ws=new Socket();s.attach(ws);
  const pending=s.forward(request());ws.close();
  await assert.rejects(pending,/disconnected/i);
  await assert.rejects(s.forward(request()),/offline/i);
});
test('relay rejects duplicate request while pending',async()=>{
  const s=new JanRelaySession(),ws=new Socket();s.attach(ws);
  const pending=s.forward(request());
  await assert.rejects(s.forward(request()),/Duplicate/);
  ws.receive(reply());await pending;s.close();
});
test('unknown reply fails closed',async()=>{
  const s=new JanRelaySession(),ws=new Socket();s.attach(ws);
  const pending=s.forward(request());
  ws.receive({...reply(),request_id:'dd4c74bd-a36b-4843-b74d-147bd69117ca'});
  await assert.rejects(pending,/disconnected/i);
});
test('gateway closes a socket when its signed lease ends',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const session=new JanRelaySession(),socket=new Socket();session.attach(socket,60);
  assert.equal(session.online,true);
  t.mock.timers.tick(60000);
  assert.equal(session.online,false);
  assert.equal(socket.readyState,3);
});
test('gateway backpressure matches the four-call agent limit',async()=>{
  const session=new JanRelaySession(),socket=new Socket();session.attach(socket);
  const ids=Array.from({length:5},(_,i)=>`c3e35d88-9749-4af8-8c13-0d097e89f77${i}`);
  const pending=ids.slice(0,4).map(request_id=>session.forward({...request(),request_id}));
  try {
    await assert.rejects(session.forward({...request(),request_id:ids[4]}),/Relay busy/);
    assert.equal(socket.sent.length,4);
    assert.equal(session.online,true);
  } finally {
    for(const request_id of ids.slice(0,4))socket.receive({...reply(),request_id});
    await Promise.all(pending);session.close();
  }
});
test('a validated late reply does not disconnect other calls or permit ID reuse',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const session=new JanRelaySession(),socket=new Socket();session.attach(socket);
  const expired=assert.rejects(session.forward(request()),/Relay timeout/);
  t.mock.timers.tick(20000);await expired;
  await assert.rejects(session.forward(request()),/Duplicate request/);
  const request_id='dd4c74bd-a36b-4843-b74d-147bd69117ca';
  const pending=session.forward({...request(),request_id});
  socket.receive(reply());
  assert.equal(session.online,true);
  socket.receive({...reply(),request_id});
  assert.equal((await pending).status,200);session.close();
});
test('expired replies still require validation and timeout history stays bounded',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const invalid=new JanRelaySession(),invalidSocket=new Socket();invalid.attach(invalidSocket);
  const expired=assert.rejects(invalid.forward(request()),/Relay timeout/);
  t.mock.timers.tick(20000);await expired;
  invalidSocket.receive({...reply(),status:500});
  assert.equal(invalid.online,false);
  const session=new JanRelaySession(),socket=new Socket();session.attach(socket);
  for(let i=0;i<128;i++){
    const request_id=`c3e35d88-9749-4af8-8c13-${i.toString(16).padStart(12,'0')}`;
    const timeout=assert.rejects(session.forward({...request(),request_id}),/Relay timeout/);
    t.mock.timers.tick(20000);await timeout;
    assert.equal(session.online,i<127);
  }
});
