import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { portalPage, trackingCleanupScript } from '../src/portal_ui.ts';

const source = readFileSync(new URL('../public/url-cleanup.js', import.meta.url), 'utf8');
test('tracking cleanup preserves OAuth, pairing, filters, hashes and history state', () => {
  const state = { navigation: 'synthetic' }, calls = [];
  const window = {
    location: { href: 'https://example.test/devices/approve?id=pair&code=oauth&state=csrf&category=files&utm_source=mail&utm_source=again&gclid=ad#permissions' },
    history: { state, replaceState: (...args) => calls.push(args) },
    addEventListener: (event, handler, options) => { assert.equal(event, 'load'); assert.equal(options.once, true); handler(); },
  };
  runInNewContext(source, { window, URL });
  assert.deepEqual(calls, [[state, '', '/devices/approve?id=pair&code=oauth&state=csrf&category=files#permissions']]);
  calls.length = 0;
  window.location.href = 'https://example.test/devices?id=pair#device';
  runInNewContext(source, { window, URL });
  assert.equal(calls.length, 0);
});

test('all static pages and nonce-protected dashboard pages include cleanup', async () => {
  const publicRoot = new URL('../public/', import.meta.url);
  for (const name of readdirSync(publicRoot, { recursive: true }).filter(name => name.endsWith('.html'))) {
    assert.match(readFileSync(new URL(name.replaceAll('\\', '/'), publicRoot), 'utf8'), /src="\/url-cleanup\.js"/);
  }
  assert.equal(trackingCleanupScript.trim(),source.trim(),'dashboard and static cleanup must stay identical');
  for(const ownerSite of [false,true])assert.ok((await portalPage('test','test',{ownerSite}).text()).includes(trackingCleanupScript));
});
