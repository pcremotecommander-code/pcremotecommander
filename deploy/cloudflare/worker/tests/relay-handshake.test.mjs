import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayHandshakeVerifier,signHandshake} from '../src/relay_handshake.ts';
import {deviceKey} from '../src/policy.ts';
const owner='12345678',device='c3e35d88-9749-4af8-8c13-0d097e89f77b',master='a'.repeat(43),now=1790000000;
const base={owner_id:owner,device_id:device,timestamp:now,nonce:'x'.repeat(24)};
const approved=async(id)=>id===device;
const signed=async value=>({...value,signature:await signHandshake(await deviceKey(master,device),value)});
test('valid signed handshake accepted once only',async()=>{
 const verifier=new RelayHandshakeVerifier(),req=await signed(base);
 assert.equal(await verifier.verify(req,owner,master,approved,now),true);
 assert.equal(await verifier.verify(req,owner,master,approved,now),false);
});
test('handshake fails if altered, expired or unapproved',async()=>{
 const req=await signed(base);
 const verifier=new RelayHandshakeVerifier();
 assert.equal(await verifier.verify({...req,nonce:'y'.repeat(24)},owner,master,approved,now),false);
 assert.equal(await verifier.verify(req,owner,master,approved,now+61),false);
 assert.equal(await verifier.verify(req,owner,master,async()=>false,now),false);
 assert.equal(await verifier.verify({...req,admin:true},owner,master,approved,now),false);
 assert.equal(await verifier.verify(req,'9999',master,approved,now),false);
 assert.equal(await verifier.verify(req,owner,'b'.repeat(43),approved,now),false);
});
