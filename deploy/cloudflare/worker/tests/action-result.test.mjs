import test from 'node:test';
import assert from 'node:assert/strict';
import {readActionResult} from '../src/action_result.ts';
import {controlRequired} from '../src/policy.ts';

const id='33333333-3333-4333-8333-333333333333';
const call=args=>({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'get_action_result',arguments:args}});
test('result polling reads only account-bound status and never retries a mutation',async()=>{
  let reads=0,sleeps=0;
  const stub={fetch:async(url,init)=>{
    assert.equal(new URL(url).pathname,'/actions/result');
    assert.equal(init.headers['X-Jan-Account-Id'],'5678');
    assert.deepEqual(JSON.parse(init.body),{id});
    return Response.json(++reads<3?{action_id:id,status:'running'}:{action_id:id,status:'completed',result:{content:[{type:'text',text:'synthetic success'}]}});
  }};
  assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify(call({action_id:id})))),false);
  const response=await readActionResult(call({action_id:id,wait_seconds:3}),stub,'5678',async()=>{sleeps++;});
  assert.equal(response.id,7);assert.equal(reads,3);assert.equal(sleeps,2);
  assert.equal(response.result.structuredContent.status,'completed');
  assert.equal(response.result.content[0].text,'synthetic success');
});
test('result errors, denial, unknown outcome, pending and input limits remain explicit',async()=>{
  for(const status of ['denied','unknown','pending']){
    const stub={fetch:async()=>Response.json({action_id:id,status})};
    const response=await readActionResult(call({action_id:id,wait_seconds:0}),stub,'5678');
    assert.equal(response.result.isError,status!=='pending');
    assert.equal(response.result.structuredContent.status,status);
  }
  assert.equal((await readActionResult(call({action_id:id,wait_seconds:0}),{fetch:async()=>new Response(null,{status:404})},'5678')).result.isError,true);
  for(const args of [{action_id:'bad'},{action_id:id,wait_seconds:16},{action_id:id,wait_seconds:-1},{action_id:id,command:'must not run'}]){
    const response=await readActionResult(call(args),{fetch:()=>assert.fail('Invalid query reached storage')},'5678');
    assert.equal(response.result.isError,true);
  }
});
test('image receipts reach the model as image content without duplicated base64',async()=>{
  const image={type:'image',mimeType:'image/jpeg',data:'aGVsbG8='.repeat(10000)};
  const stub={fetch:async()=>Response.json({action_id:id,status:'completed',result:{content:[image],structuredContent:{frame_id:'synthetic-frame'}}})};
  const response=await readActionResult(call({action_id:id,wait_seconds:0}),stub,'5678');
  assert.deepEqual(response.result.content,[image]);
  assert.equal(response.result.structuredContent.result.structuredContent.frame_id,'synthetic-frame');
  assert.ok(!JSON.stringify(response.result.structuredContent).includes(image.data));
});
