import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ownerFixture,unlockOwner} from './helpers/owner-console-fixture.mjs';
import {totpCode} from '../src/owner_security.ts';
import {digest} from '../src/device_portal.ts';

test('native owner authenticator forms preserve same-origin validation',{skip:process.env.PCRC_OWNER_BROWSER_QA!=='1',timeout:30000},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.PCRC_PLAYWRIGHT_MODULE).href);
  const f=await ownerFixture({PCRC_OWNER_GITHUB_ID:'5678'}),posts=[];
  await f.callStore('/session/create',{hash:await digest(f.token),login:'synthetic-new-owner',csrf:f.csrf,userId:'1234',ownerGithubId:'5678',ownerOrigin:f.origin,ownerLoginAt:Date.now()});
  const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage();
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());assert.equal(url.origin,f.origin);
    if(url.pathname==='/brand/pcrc-logo.svg'){await route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});return;}
    const headers=await req.allHeaders();headers.Cookie='__Host-JanPortal='+f.token;
    if(req.method()==='POST')posts.push({path:url.pathname,origin:headers.origin});
    const response=await f.request(url.pathname+url.search,{method:req.method(),headers,...(req.postData()?{body:req.postData()}: {})});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  try{
    await page.goto(f.origin+'/admin/security');
    const [setup]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/admin/security/setup')),page.getByRole('button',{name:'Start authenticator setup',exact:true}).click()]);
    assert.equal(posts.at(-1).origin,f.origin,'The browser must supply its real origin without test injection');
    assert.equal(setup.status(),200);
    const secret=(await page.locator('code.setup-key').textContent()).trim();
    await page.getByLabel('Authenticator or recovery code').fill(await totpCode(secret,Math.floor(Date.now()/30000)));
    const [verified]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/admin/security/verify')),page.getByRole('button',{name:'Enable authenticator',exact:true}).click()]);
    assert.equal(verified.status(),200);assert.equal(posts.at(-1).origin,f.origin);
    await page.getByRole('link',{name:'Continue to analytics',exact:true}).click();await page.getByRole('heading',{name:'Analytics',exact:true}).waitFor();
    console.log(JSON.stringify({native_form_posts:posts.length,browser_origins_valid:true,private_accounts_used:false}));
  }finally{await context.close();await browser.close();}
});

test('native Reset button explains provider and local limits without replaying email',{skip:process.env.PCRC_OWNER_BROWSER_QA!=='1',timeout:30000},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.PCRC_PLAYWRIGHT_MODULE).href);
  const f=await ownerFixture({SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'a'.repeat(25)});f.env.PCRC_PUBLIC_SITE_ORIGIN=f.origin;await unlockOwner(f);
  const subject='12345678-1234-4123-8123-123456789abc',account='s-'+subject;
  await f.callStore('/email-identity/resolve',{subject,email:'synthetic@example.test',username:'resettest'});await f.callStore('/directory/register',{id:account,login:'resettest'});
  let sends=0;const provider=async()=>{sends++;return Response.json({code:'over_email_send_rate_limit',message:'synthetic private provider detail'},{status:429});};
  const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage();
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());assert.equal(url.origin,f.origin);
    if(url.pathname==='/brand/pcrc-logo.svg'){await route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});return;}
    const headers=await req.allHeaders();headers.Cookie='__Host-JanPortal='+f.token;
    if(req.method()==='POST')assert.equal(headers.origin,f.origin);
    const response=await f.request(url.pathname+url.search,{method:req.method(),headers,...(req.postData()?{body:req.postData()}: {})},provider);
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  try{
    await page.goto(f.origin+'/admin/users?'+new URLSearchParams({user:account}));
    async function reset(){await page.locator('summary').filter({hasText:'Password reset'}).click();const [r]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/admin/users/action')),page.getByRole('button',{name:'Send password-reset email',exact:true}).click()]);assert.equal(r.status(),429);}
    await reset();await page.getByRole('heading',{name:'Reset email is rate limited',exact:true}).waitFor();assert.equal(sends,1);
    await page.getByRole('link',{name:'Back to user details',exact:true}).click();await reset();
    await page.getByRole('heading',{name:'Check your reset email',exact:true}).waitFor();assert.equal(sends,1);
    assert.ok(!(await page.locator('body').innerText()).includes('synthetic private provider detail'));
    console.log(JSON.stringify({native_reset_button_posts:2,provider_attempts:1,real_emails_sent:0}));
  }finally{await context.close();await browser.close();}
});

test('owner console rendered flow: analytics, name-only grid, searchable user dialog, keyboard and mobile',{skip:process.env.PCRC_OWNER_BROWSER_QA!=='1',timeout:120000},async()=>{
  assert.ok(process.env.PCRC_PLAYWRIGHT_MODULE,'Use the installed Playwright module; do not install another copy');
  const {chromium}=await import(pathToFileURL(process.env.PCRC_PLAYWRIGHT_MODULE).href);
  const f=await ownerFixture();await unlockOwner(f);
  for(let i=0;i<24;i++){const id=String(6000+i);await f.callStore('/directory/register',{id,login:'demo-user-'+String(i).padStart(2,'0')});await f.callStore('/device/list',{},id);await f.storages.get(id).put('devices',{['00000000-0000-4000-8000-'+String(i).padStart(12,'0')]:{id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),name:'Demo laptop '+i,created:Date.now(),revoked:false,ownerId:id,publicKey:'synthetic-key'}});}
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());assert.equal(url.origin,f.origin,'No external network request is allowed in this fixture');
    if(url.pathname==='/brand/pcrc-logo.svg'){await route.fulfill({status:200,contentType:'image/svg+xml',body:await readFile(new URL('../owner-public/brand/pcrc-logo.svg',import.meta.url))});return;}
    const headers=await req.allHeaders();headers.Cookie='__Host-JanPortal='+f.token;
    const response=await f.request(url.pathname+url.search,{method:req.method(),headers,...(req.postData()?{body:req.postData()}: {})});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const out=resolve(process.env.PCRC_OWNER_SCREENSHOTS||'../../../work/owner-console-screenshots');await mkdir(out,{recursive:true});
  try{
    await page.goto(f.origin+'/admin');await page.getByRole('button',{name:'Refresh analytics',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.owner-metric strong')?.textContent==='25');
    await page.screenshot({path:resolve(out,'analytics-desktop.png'),fullPage:true});
    await page.getByRole('link',{name:'Users',exact:true}).click();
    assert.equal(await page.locator('a[data-open-user]').count(),20);
    assert.equal(await page.locator('[data-owner-dialog]').count(),0);
    await page.getByLabel('Find a user').fill('demo laptop 7');await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('heading',{name:'Search results',exact:true}).waitFor();assert.equal(await page.locator('a[data-open-user]').count(),1);
    await page.locator('a[data-open-user]').click();await page.getByRole('dialog').waitFor();
    await page.getByRole('heading',{name:'demo-user-07',exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Close user details'}).evaluate(el=>el===document.activeElement),true);
    await page.screenshot({path:resolve(out,'user-details-desktop.png'),fullPage:true});
    await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
    await page.setViewportSize({width:390,height:844});await page.goto(f.origin+'/admin/users');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:resolve(out,'users-mobile.png'),fullPage:true});
    await page.locator('a[data-open-user]').first().click();await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:resolve(out,'user-details-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({synthetic_browser_checks:9,external_requests:0,screenshots:4}));
  }finally{await context.close();await browser.close();}
});
