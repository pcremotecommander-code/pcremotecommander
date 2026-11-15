import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {billingReady,billingApiReady} from '../src/billing.ts';
import {permittedAccount} from '../src/account_identity.ts';

const load=name=>JSON.parse(readFileSync(new URL(`../wrangler.${name}.example.json`,import.meta.url),'utf8'));

test('public configuration examples isolate resources and disable unconfigured providers',()=>{
 const publicConfig=load('public-production'),owner=load('owner-production'),staging=load('public-staging');
 assert.equal(owner.durable_objects.bindings[0].script_name,publicConfig.name);
 assert.deepEqual(publicConfig.services,[{binding:'BILLING_SERVICE',service:owner.name}]);
 assert.notEqual(publicConfig.name,staging.name);
 assert.notEqual(publicConfig.kv_namespaces[0].id,staging.kv_namespaces[0].id);
 assert.notEqual(publicConfig.r2_buckets[0].bucket_name,staging.r2_buckets[0].bucket_name);
 assert.deepEqual(owner.assets,{directory:'./owner-public'});
 for(const config of [publicConfig,owner])assert.equal(config.vars.PCRC_OWNER_GITHUB_ID,'5678');
 assert.equal(owner.vars.PCRC_PUBLIC_SITE_ORIGIN,publicConfig.vars.JAN_PUBLIC_ORIGIN);
 assert.equal(owner.vars.SUPABASE_URL,publicConfig.vars.SUPABASE_URL);
 assert.deepEqual(readFileSync(new URL('../owner-public/brand/pcrc-logo.svg',import.meta.url)),readFileSync(new URL('../public/brand/pcrc-logo.svg',import.meta.url)));
 for(const config of [publicConfig,owner,staging]){
  assert.equal(config.vars.ALLOWED_GITHUB_ID,'1234');
  assert.equal(config.vars.GITHUB_CLIENT_ID,'');
  assert.equal(config.vars.PADDLE_PRICE_ID,'');
  for(const key of ['GITHUB_CLIENT_SECRET','PADDLE_WEBHOOK_SECRET','PADDLE_LIVE_API_KEY','JAN_PROXY_KEY'])assert.equal(config.vars[key],undefined);
  assert.equal(billingReady(config.vars),false);assert.equal(billingApiReady(config.vars),false);
  assert.equal(permittedAccount('5678',config.vars.ALLOWED_GITHUB_ID,config.vars.JAN_MULTI_USER_ENABLED,config.vars.JAN_BETA_GITHUB_IDS),'5678');
 }
});
