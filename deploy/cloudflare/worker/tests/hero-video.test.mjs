import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/hero-video.js',import.meta.url),'utf8');
function setup({reduced=false,reject=false}={}) {
  const events={},soundEvents={},preferenceEvents={},classes=new Map(),attributes={};
  const video={muted:false,paused:true,currentTime:18,plays:0,autoplay:false,
    addEventListener:(event,fn)=>{events[event]=fn;},
    async play(){this.plays++;if(reject)throw Error('Autoplay denied');this.paused=false;events.play?.();},
    pause(){this.paused=true;events.pause?.();}};
  const sound={addEventListener:(event,fn)=>{soundEvents[event]=fn;},setAttribute:(name,value)=>{attributes[name]=value;}};
  const preference={matches:reduced,addEventListener:(event,fn)=>{preferenceEvents[event]=fn;}};
  const hero={classList:{toggle:(name,value)=>classes.set(name,value)}};
  vm.runInNewContext(source,{document:{querySelector:s=>({'#hero-video':video,'#hero-sound':sound,'.hero-motion':hero}[s])},matchMedia:()=>preference});
  return {video,sound,events,soundEvents,preference,preferenceEvents,classes,attributes};
}
test('hero starts muted, enables sound on a click and pauses decorative motion with playback',async()=>{
  const s=setup();assert.equal(s.video.plays,1);assert.equal(s.video.autoplay,true);assert.equal(s.video.muted,true);
  await s.soundEvents.click();assert.equal(s.video.muted,false);assert.equal(s.video.currentTime,0);assert.equal(s.attributes['aria-pressed'],'true');assert.equal(s.sound.textContent,'Mute sound');
  s.video.pause();assert.equal(s.classes.get('motion-paused'),true);
  await s.soundEvents.click();assert.equal(s.video.muted,true);assert.equal(s.sound.textContent,'Play with sound');
});
test('reduced motion does not autoplay and responds to a preference change',()=>{
  const r=setup({reduced:true});assert.equal(r.video.plays,0);assert.equal(r.video.autoplay,false);
  const s=setup();s.preference.matches=true;s.preferenceEvents.change();assert.equal(s.video.paused,true);assert.equal(s.video.autoplay,false);
});
test('blocked playback leaves usable native controls and honest sound state',async()=>{
  const s=setup({reject:true});await Promise.resolve();await s.soundEvents.click();assert.equal(s.video.muted,true);assert.equal(s.attributes['aria-pressed'],'false');assert.equal(s.classes.get('motion-paused'),true);
});
test('native volume changes synchronize the sound button',()=>{
  const s=setup();s.video.muted=false;s.events.volumechange();assert.equal(s.sound.textContent,'Mute sound');
});
test('home includes wide looping media, optional captions and allowed media policy',()=>{
  const page=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(page,/media-src 'self'/);assert.match(page,/<video[^>]+muted loop playsinline controls/);assert.match(page,/width="1280" height="720"/);
  assert.match(page,/<track kind="captions"/);assert.doesNotMatch(page,/Setup link in the post/);
  for(const path of ['/hero.css','/hero-video.js','/media/pcrc-hero-wide-v1.mp4','/media/pcrc-hero-poster-v1.jpg','/media/pcrc-hero-v1.vtt']){
    assert.ok(page.includes(path));
    if(!path.endsWith('.mp4') || process.env.PCRC_SOURCE_ONLY_TESTS !== '1') assert.ok(existsSync(new URL('../public'+path,import.meta.url)));
  }
});

test('hero release recording exists',{skip:process.env.PCRC_SOURCE_ONLY_TESTS === '1' ? 'Source checkout excludes private demo recordings' : false},()=>{
 assert.ok(existsSync(new URL('../public/media/pcrc-hero-wide-v1.mp4',import.meta.url)));
});
