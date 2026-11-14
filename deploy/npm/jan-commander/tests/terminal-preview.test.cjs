'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {terminalPreview,onlineStatus,offlineStatus}=require('../bin/relay-agent.cjs');

test('live terminal previews redact secrets, encoded images, URL credentials and terminal escapes',()=>{
 const data={command:'echo hello',password:'never-print-password',nested:{apiKey:'never-print-key'},url:'https://example.test/callback?code=never-print-code&state=never-print-state',database:'postgres://user:never-print-db@example.test/db',message:'Bearer never-print-bearer\u001b[2J',content:[{type:'image',data:'never-print-image'},{type:'text',text:'{"access_token":"never-print-token","count":2}'}]};
 const preview=terminalPreview(JSON.stringify(data));
 assert.ok(preview.includes('echo hello'));assert.ok(preview.includes('[redacted]'));
 assert.doesNotMatch(preview,/never-print|\u001b/);
 assert.ok(terminalPreview({items:Array.from({length:500},()=> 'x'.repeat(10000))}).length<=2000);
 assert.doesNotMatch(terminalPreview({text:'-----BEGIN PRIVATE KEY-----\nnever-print-pem\n-----END PRIVATE KEY-----'}),/never-print/);
});

test('terminal previews do not copy numeric PINs or labeled credentials from filenames and ordinary text',()=>{
 const preview=terminalPreview({pin:8264,otp:827461,path:'password=synthetic-private-path.txt',text:'PAN: ABCDE1234F',card:'4111 1111 1111 1111',count:2});
 assert.doesNotMatch(preview,/8264|827461|synthetic-private-path|ABCDE1234F|4111/);
 assert.match(preview,/"count":2/);
});

test('ready status uses verified paired account metadata and shows offline retry timing',()=>{
 const session={owner_id:'1234',name:'Synthetic PC'};
 const status=onlineStatus(session,{'x-pcrc-account-id':'1234','x-pcrc-account-name':'test-owner'});
 assert.match(status,/ONLINE/);assert.doesNotMatch(status,/Ready for requests|workflow skills|Transport:/);assert.match(status,/test-owner/);assert.match(status,/1234/);
 assert.match(status,/\nReady to work\n/);assert.doesNotMatch(status,/\x1b/);
 assert.match(onlineStatus(session,{},true),/\x1b\[92mReady to work\x1b\[0m/);
 assert.doesNotMatch(onlineStatus(session,{'x-pcrc-account-id':'5678','x-pcrc-account-name':'wrong-user'}),/wrong-user/);
 assert.match(offlineStatus(30000),/OFFLINE.*30 seconds/);
});
