import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRelayRequest, validateRelayReply} from '../src/relay_protocol.ts';
const id='c3e35d88-9749-4af8-8c13-0d097e89f77b';
test('valid relay messages', () => {
  const req={type:'request',request_id:id,control:false,payload:JSON.stringify({jsonrpc:'2.0',method:'ping',id:1})};
  assert.equal(validateRelayRequest(req).request_id,id);
  const reply={type:'response',request_id:id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{}})};
  assert.equal(validateRelayReply(reply).status,200);
});
test('invalid relay envelopes fail', () => {
  const req={type:'request',request_id:id,control:false,payload:JSON.stringify({jsonrpc:'2.0',method:'ping',id:1})};
  assert.throws(()=>validateRelayRequest({...req,request_id:'bad'}));
  assert.throws(()=>validateRelayRequest({...req,extra:true}));
  assert.throws(()=>validateRelayRequest({...req,payload:'{}'}));
  assert.throws(()=>validateRelayReply({type:'response',request_id:id,status:302,payload:''}));
  assert.throws(()=>validateRelayReply({type:'response',request_id:id,status:204,payload:'nonempty'}));
});
