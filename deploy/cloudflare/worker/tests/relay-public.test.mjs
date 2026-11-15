import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
test('public device connection route is narrowly scoped',()=>{
 assert.match(source,/path==='\/jan-relay\/connect'/);
 assert.match(source,/request\.method!=='GET'/);
 assert.match(source,/request\.headers\.get\('Upgrade'\)/);
 assert.match(source,/X-JAN-Device-Proof/);
 assert.match(source,/stub\.fetch\('https:\/\/internal\.invalid\/relay\/connect'/);
});
test('public relay route does not expose DO dispatch through unauthenticated URL',()=>{
 assert.doesNotMatch(source,/path==='\/relay\/dispatch'/);
 assert.doesNotMatch(source,/path==='\/jan-relay\/dispatch'/);
});
test('owner operations paths reach the portal authorization handler',()=>{
 assert.match(source,/path==='\/admin'\|\|path\.startsWith\('\/admin\/'\)/);
 assert.match(source,/return portal\(request/);
});
