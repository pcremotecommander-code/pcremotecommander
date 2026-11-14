import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {themeInit,themeScript} from '../src/portal_theme.ts';
function fixture(saved,blocked=false){
 const values=new Map(saved===undefined?[]:[['pcrc-color-theme',saved]]),root={dataset:{},hasAttribute:name=>name==='data-pcrc-ui'},handlers={},windowHandlers={},label={},icon={},attributes={};
 const button={setAttribute:(k,v)=>attributes[k]=v,querySelector:selector=>selector==='[data-theme-label]'?label:icon,addEventListener:(name,callback)=>handlers[name]=callback};
 const context=vm.createContext({document:{documentElement:root,querySelector:()=>button},window:{addEventListener:(name,callback)=>windowHandlers[name]=callback},localStorage:{getItem:key=>{if(blocked)throw Error('Storage blocked');return values.get(key);},setItem:(key,value)=>{if(blocked)throw Error('Storage blocked');values.set(key,value);}}});
 vm.runInContext(themeInit,context);vm.runInContext(themeScript,context);
 return {root,values,handlers,windowHandlers,label,icon,attributes};
}
test('theme defaults to light and toggle persists only the chosen theme',()=>{
 const f=fixture();assert.notEqual(f.root.dataset.theme,'dark');assert.equal(f.attributes['aria-pressed'],'false');
 f.handlers.click();assert.equal(f.root.dataset.theme,'dark');assert.equal(f.values.get('pcrc-color-theme'),'dark');assert.equal(f.attributes['aria-pressed'],'true');assert.equal(f.label.textContent,'Light mode');
 f.handlers.click();assert.equal(f.root.dataset.theme,'light');assert.equal(f.values.get('pcrc-color-theme'),'light');assert.equal(f.values.size,1);
});
test('theme is restored before paint and ignores unrecognized persisted values',()=>{
 assert.equal(fixture('dark').root.dataset.theme,'dark');assert.notEqual(fixture('unexpected').root.dataset.theme,'dark');
});
test('theme toggle works with blocked storage and synchronizes other tabs',()=>{
 const f=fixture(undefined,true);f.handlers.click();assert.equal(f.root.dataset.theme,'dark');
 f.windowHandlers.storage({key:'pcrc-color-theme',newValue:'light'});assert.equal(f.root.dataset.theme,'light');assert.equal(f.attributes['aria-pressed'],'false');
});
