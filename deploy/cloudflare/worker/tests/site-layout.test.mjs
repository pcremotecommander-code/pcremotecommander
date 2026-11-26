import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';

const publicRoot=new URL('../public/',import.meta.url);
const htmlFiles=readdirSync(publicRoot,{recursive:true}).filter(path=>path.endsWith('.html'));
test('public pages share an accessible footer and local motion assets',()=>{
  let footer;
  for(const path of htmlFiles){
    const page=readFileSync(new URL(path,publicRoot),'utf8');
    const current=page.match(/<footer class="site-footer"[\s\S]*?<\/footer>/)?.[0]?.replace(/\r\n/g,"\n");
    assert.ok(current,path);footer??=current;assert.equal(current,footer,path);
    for(const group of ['Product','Resources','Legal'])assert.ok(current.includes(`aria-label="${group} links"`),path);
    assert.match(current,/id="reduce-motion"/);assert.match(current,/href="\/sitemap\/"/);
    const social=current.match(/<nav class="footer-social"[\s\S]*?<\/nav>/)?.[0];assert.ok(social,path);
    for(const destination of ['https://github.com/pcremotecommander-code/pcremotecommander','https://x.com/pcremotecommand','https://www.instagram.com/pcremotecommander?vrfl=MTd4eXJjbnVvZ296Mg=='])assert.ok(social.includes(destination),path);
    assert.match(social,/aria-label="PCRC on GitHub/);assert.match(social,/<svg[^>]+aria-hidden="true"/);assert.doesNotMatch(social,/href="#"/);
    for(const asset of ['/site.css','/site-motion.js','/vendor/gsap/gsap.min.js','/vendor/gsap/ScrollTrigger.min.js'])assert.ok(page.includes(asset),path);
    assert.match(page,/name="viewport"/);assert.match(page,/id="main"/);
    assert.doesNotMatch(page,/script src="https:\/\/.*gsap/);
  }
});
const source=readFileSync(new URL('site-motion.js',publicRoot),'utf8');
function setup({reduced=false,stored=false,library=true,fail=false,hash=''}={}){
  const listeners={},preferences={},root={dataset:{}},store={},calls=[],windowEvents={};
  const control={checked:false,disabled:false,addEventListener:(e,f)=>listeners[e]=f};
  const video={autoplay:true,paused:false,pause(){this.paused=true;}};
  const svg={paused:false,pauseAnimations(){this.paused=true;},unpauseAnimations(){this.paused=false;}};
  const preference={matches:reduced,addEventListener:(e,f)=>preferences[e]=f};
  let reverts=0;
  const gsap={registerPlugin(){},matchMedia(){return {revert(){reverts++;},add(query,fn){if(fail)throw Error('setup failed');if(typeof query==='object')fn({conditions:{mobile:false,motion:true}});}};},to(...args){calls.push(args);},from(){},fromTo(){}};
  let anchorScrolls=0;
  const document={documentElement:root,body:{},getElementById:id=>id==='connection-map'?{scrollIntoView(){anchorScrolls++;}}:null,querySelector:s=>s==='#reduce-motion'?control:null,querySelectorAll:s=>s==='video[loop]'?[video]:s==='svg.network-lines'?[svg]:[]};
  const window={...(library?{gsap,ScrollTrigger:{}}:{}),location:{hash},requestAnimationFrame:fn=>fn(),addEventListener:(e,fn)=>{windowEvents[e]=fn;}};
  vm.runInNewContext(source,{document,window,matchMedia:()=>preference,localStorage:{getItem:()=>String(stored),setItem:(k,v)=>store[k]=v}});
  return {root,control,video,svg,listeners,preference,preferences,store,calls,windowEvents,get anchorScrolls(){return anchorScrolls;},get reverts(){return reverts;}};
}
test('system reduced motion disables animation and pauses looping media',()=>{
  const s=setup({reduced:true});assert.equal(s.root.dataset.motion,'off');assert.equal(s.control.disabled,true);assert.equal(s.control.checked,true);assert.equal(s.video.paused,true);assert.equal(s.svg.paused,true);assert.equal(s.calls.length,0);
});
test('manual motion preference persists and reverts scroll effects',()=>{
  const s=setup();assert.equal(s.root.dataset.motion,'on');assert.ok(s.calls.length);
  s.control.checked=true;s.listeners.change();assert.equal(s.root.dataset.motion,'off');assert.equal(s.store['pcrc-reduce-motion'],'true');assert.equal(s.reverts,1);assert.equal(s.video.paused,true);
  assert.equal(setup({stored:true}).root.dataset.motion,'off');
});
test('missing or failed animation library leaves the page functional',()=>{
  const missing=setup({library:false});assert.equal(missing.root.dataset.motion,'on');
  const failed=setup({fail:true});assert.equal(failed.reverts,1);
});
test('changed OS preference stops already-running animations',()=>{
  const s=setup();s.preference.matches=true;s.preferences.change();assert.equal(s.root.dataset.motion,'off');assert.equal(s.video.paused,true);assert.equal(s.reverts,1);
});
test('direct section links survive animation initialization and malformed hashes are harmless',()=>{
  const s=setup({hash:'#connection-map'});s.windowEvents.load();assert.equal(s.anchorScrolls,1);
  const invalid=setup({hash:'#%ZZ'});assert.doesNotThrow(()=>invalid.windowEvents.load());assert.equal(invalid.anchorScrolls,0);
});
