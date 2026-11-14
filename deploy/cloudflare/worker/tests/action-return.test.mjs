import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {portalPage} from '../src/portal_ui.ts';
const source=readFileSync(new URL('../public/action-return.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111';
function run(status,referrer='',saved=null,returning=true){
  const store=new Map(saved?[['pcrc-action-return:'+id,saved]]:[]),timers=[],nodes=[];let closed=0,focused=0;
  const page={dataset:{actionId:id,actionStatus:status},append:(...items)=>nodes.push(...items)};
  const element=()=>({children:[],append(...items){this.children.push(...items);},setAttribute(){},addEventListener(name,fn){this[name]=fn;}});
  vm.runInNewContext(source,{URL,document:{referrer,querySelector:()=>page,createElement:element},sessionStorage:{setItem:(k,v)=>store.set(k,v),getItem:k=>store.get(k),removeItem:k=>store.delete(k)},window:{location:{hash:returning?'#return-to-chat':''},opener:{focus(){focused++;}},close(){closed++;}},setTimeout:fn=>timers.push(fn)});
  return {store,timers,nodes,get closed(){return closed;},get focused(){return focused;}};
}
test('website return stores only safe chat paths and never approves, redirects or closes pending/unknown actions',()=>{
  const pending=run('pending','https://chatgpt.com/c/synthetic-chat?private=omit#omit');
  assert.equal(pending.store.get('pcrc-action-return:'+id),'https://chatgpt.com/c/synthetic-chat');
  assert.equal(pending.closed,0);assert.equal(pending.timers.length,0);
  for(const bad of ['https://chatgpt.com.evil.example/c/chat','javascript:alert(1)','http://claude.ai/chat/example','https://user@claude.ai/chat/example'])assert.equal(run('pending',bad).store.size,0);
  assert.equal(run('unknown').timers.length,0);
  const done=run('completed','',pending.store.get('pcrc-action-return:'+id));
  assert.equal(done.nodes[0].children[1].href,'https://chatgpt.com/c/synthetic-chat');
  assert.equal(done.store.size,0);assert.equal(done.timers.length,1);
  done.timers[0]();assert.equal(done.closed,1);assert.equal(done.focused,1);
  const denied=run('denied','', 'https://evil.example');assert.equal(denied.nodes[0].children.length,1);
  assert.equal(run('completed','',null,false).timers.length,0,'reviewing an old result does not close its tab');
});
test('return script is nonce-authorized only on explicitly marked action pages',async()=>{
  const response=portalPage('<section data-action-return></section>','Review action',{actionReturn:true});
  const html=await response.text();assert.match(html,/nonce="[a-f0-9]+" src="\/action-return\.js" defer/);
  assert.ok(!(await portalPage('Ordinary page').text()).includes('/action-return.js'));
});
