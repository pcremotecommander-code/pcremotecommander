import {boundedBody,config,escaped,failure,type Settings} from './policy.ts';
import {portalPage,hidden,button,type PortalOwner} from './portal_ui.ts';
import {operatorProof} from './owner_data.ts';
import {billingApiReady} from './billing.ts';
import {internalBillingHistory} from './billing_history.ts';
import {costAmount,money,refreshRevenue,type OwnerStore} from './owner_finance.ts';
import {randomCode,digest} from './device_portal.ts';
import {s256} from './authorization.ts';

type Owner=PortalOwner&{ownerOrigin?:string;ownerLoginAt?:number;ownerGithubId?:string};
type Env=Settings&{DEVICES:DurableObjectNamespace;PCRC_PUBLIC_SITE_ORIGIN?:string};
const time=(value:unknown)=>typeof value==='number'&&value>0?new Date(value).toISOString().replace('T',' ').slice(0,16)+' UTC':'Not recorded';
const panel=(title:string,content:string)=>'<section class="panel"><div class="panel-body"><h2>'+escaped(title)+'</h2>'+content+'</div></section>';
const page=(body:string,title:string,owner:Owner,active:string,status=200)=>portalPage(body,title,{owner,ownerSite:true,active,status});
const heading=(title:string,sub:string,action='')=>'<header class="owner-heading"><div><p class="owner-kicker">PCRC owner workspace</p><h1>'+escaped(title)+'</h1><p class="subtitle">'+escaped(sub)+'</p></div>'+action+'</header>';
const ownerRedirect=(url:string)=>new Response(null,{status:303,headers:{Location:url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const notice=(message:string,error=false)=>message?'<p class="owner-message'+(error?' owner-error':'')+'" role="status">'+escaped(message)+'</p>':'';
const back=(q='')=>'/admin/users'+(q?'?'+new URLSearchParams({q}):'');
const csrf=(owner:Owner)=>hidden('csrf',owner.csrf);
async function sessionHash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('PCRC_OWNER_SESSION_V1\n'+value))),x=>x.toString(16).padStart(2,'0')).join('');}
async function form(request:Request,env:Env,owner:Owner){
  if(request.headers.get('Origin')!==config(env).publicOrigin||request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')throw Error('Form origin denied');
  const values=new URLSearchParams(new TextDecoder().decode(await boundedBody(request,32768)));if(values.get('csrf')!==owner.csrf)throw Error('Form expired. Reload this page.');return values;
}
async function operator(env:Env,path:string,body:unknown,accountId:string){
  const raw=JSON.stringify(body),timestamp=String(Date.now()),proof=await operatorProof(env.JAN_PROXY_KEY,path,accountId,timestamp,raw);
  const response=await env.DEVICES.get(env.DEVICES.idFromName(accountId)).fetch('https://internal.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':accountId,'X-PCRC-Operator-Time':timestamp,'X-PCRC-Operator-Proof':proof},body:raw});
  if(!response.ok)throw Error('The account action was not confirmed. Refresh its details before another request.');return response.json() as Promise<any>;
}
function securityPage(owner:Owner,enabled:boolean,key='',message='',recovery:string[]=[],reauth=false,status=message?403:200){
  const content=reauth?'<h2>Refresh your owner sign-in</h2><p>Authenticator setup requires a GitHub sign-in from the last ten minutes.</p><a class="button primary" href="/owner/login">Sign in again with GitHub</a>':recovery.length?notice('Authenticator enabled. Save these recovery codes privately. Each works once.')+'<ul class="recovery-codes">'+recovery.map(code=>'<li>'+escaped(code)+'</li>').join('')+'</ul><a class="button primary" href="/admin">Continue to analytics</a>':
    (key?'<h2>Connect your authenticator</h2><p>In Google Authenticator, Microsoft Authenticator or another TOTP app, add an account using a setup key. Choose a time-based code.</p><code class="setup-key">'+escaped(key)+'</code><p class="footnote">Account name: PCRC owner. This setup expires in five minutes.</p>':'<h2>'+(enabled?'Enter your authenticator code':'Add your second sign-in step')+'</h2><p>'+(enabled?'Use the current six-digit code or one unused recovery code.':'First sign in through the owner GitHub app, then connect your authenticator. Public-site sessions cannot configure owner access.')+'</p>')+
    (enabled||key?'<form method="post" action="/admin/security/verify">'+csrf(owner)+'<label for="owner-code">Authenticator or recovery code</label><input id="owner-code" name="code" autocomplete="one-time-code" maxlength="16" required autofocus><div class="owner-form-actions">'+button(key?'Enable authenticator':'Verify and continue')+'</div></form>':'<form method="post" action="/admin/security/setup">'+csrf(owner)+button('Start authenticator setup')+'</form>');
  return page('<div class="owner-security">'+heading('Owner verification','GitHub sign-in + authenticator protection')+panel('Secure access',notice(message,true)+content)+'</div>','Owner verification',owner,'security',status);
}

async function ownerReset(env:Env,owner:Owner,account:string,store:OwnerStore,fetcher:typeof fetch){
  const result=(title:string,message:string,status:number)=>page(heading(title,message)+'<a href="/admin/users?'+escaped(new URLSearchParams({user:account}).toString())+'">Back to user details</a>',title,owner,'accounts',status);
  let stage='lookup';
  try{
    const target=await store('/owner-data/email',{id:account}),publicOrigin=env.PCRC_PUBLIC_SITE_ORIGIN;
    if(!target.email)return result('Password reset unavailable','This account has no linked email/password sign-in. GitHub-only accounts recover their password at GitHub.',409);
    if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+$/.test(publicOrigin??'')||!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL??'')||!/^sb_publishable_[A-Za-z0-9_-]{15,200}$/.test(env.SUPABASE_PUBLISHABLE_KEY??''))return result('Reset email is not configured','Check the owner email-provider and public callback settings. No email was requested.',503);
    stage='prepare';const reset=randomCode(),verifier=randomCode()+randomCode();
    const prepared=await store('/owner-data/reset-start',{id:account,hash:await digest(reset),verifier});
    const callback=new URL(publicOrigin!+'/devices/email/callback');callback.searchParams.set('reset',reset);
    stage='send';
    const response=await fetcher(env.SUPABASE_URL+'/auth/v1/recover?redirect_to='+encodeURIComponent(callback.href),{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',apikey:env.SUPABASE_PUBLISHABLE_KEY!},body:JSON.stringify({email:prepared.email,code_challenge:await s256(verifier),code_challenge_method:'s256'})});
    if(!response.ok){
      let code='';try{const bytes=await boundedBody(new Request('https://response.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),8192);const data=JSON.parse(new TextDecoder().decode(bytes));code=data.code??data.error_code??'';}catch{}
      if(response.status===429)return result('Reset email is rate limited','The email provider has limited reset requests. Check the inbox first and wait before another request. Review the provider email quota and SMTP settings.',429);
      if(code==='email_address_not_authorized')return result('Email delivery needs configuration','The email provider does not allow delivery to this address. Configure production SMTP before sending resets to public users.',503);
      if(code==='invalid_api_key'||response.status===401)return result('Email-provider access failed','Check the owner email-provider key configuration. No successful delivery was confirmed.',503);
      return result('Reset email was not accepted','The email provider returned HTTP '+response.status+'. Check its Auth/SMTP logs and callback configuration. Delivery is not confirmed; no automatic retry was made.',503);
    }
    return ownerRedirect(config(env).publicOrigin+'/admin/users?'+new URLSearchParams({user:account,saved:'reset'}));
  }catch(error){
    const status=(error as {status?:number})?.status;
    if(stage==='prepare'&&status===429)return result('Check your reset email','This click sent no additional email. If you received a reset email from an earlier request, use that link; you do not need another request. To avoid duplicate emails, wait at least five minutes after your last request before trying again. If you made no recent request, recovery is temporarily busy.',429);
    if(stage==='send')return result('Reset delivery could not be confirmed','Check the inbox before requesting another reset. The provider response was interrupted; no automatic retry was made.',502);
    return result('Reset request could not start','The account or verified email could not be loaded. Refresh user details before trying again. This attempt sent no email.',503);
  }
}

/** Returns null only for legacy owner pages, after the same MFA gate has passed. */
export async function ownerConsole(request:Request,env:Env,owner:Owner|null,store:OwnerStore,fetcher:typeof fetch=fetch):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname;
  if(path!=='/admin'&&!path.startsWith('/admin/'))return null;
  if(env.JAN_SITE_ROLE!=='owner')return failure(env.JAN_SITE_ROLE==='public'?404:403,'Owner site required');
  if(!owner){if(request.method!=='GET'||path!=='/admin')return failure(403,'Owner sign-in required');return portalPage('<div class="owner-security">'+heading('Owner sign-in','Private administration for PC Remote Commander')+panel('Two-step access','<p>Use the owner GitHub account, then your authenticator app.</p><a class="button primary" href="/owner/login">Sign in with owner GitHub</a>')+'</div>','Owner sign-in',{ownerSite:true});}
  if(owner.userId!==env.ALLOWED_GITHUB_ID)return failure(403,'Owner account required');
  if((owner.ownerGithubId??owner.userId)!==(env.PCRC_OWNER_GITHUB_ID??env.ALLOWED_GITHUB_ID))return page(heading('Owner sign-in changed','Sign in with the GitHub account currently configured to manage PCRC.')+'<a class="button primary" href="/owner/login">Sign in with the configured owner GitHub account</a>','Owner sign-in required',owner,'security',403);
  if(owner.ownerOrigin!==config(env).publicOrigin||typeof owner.ownerLoginAt!=='number'||owner.ownerLoginAt>Date.now()||Date.now()-owner.ownerLoginAt>86400000)return page(heading('Sign in on the owner site','This session did not originate from the owner GitHub sign-in.')+'<a class="button primary" href="/owner/login">Continue with owner GitHub</a>','Owner sign-in required',owner,'security',403);
  const binding=await sessionHash(owner.csrf),recent=Date.now()-owner.ownerLoginAt<600000;
  const principal=env.PCRC_OWNER_GITHUB_ID??env.ALLOWED_GITHUB_ID;
  const security=await store('/owner-auth/status',{session:binding,principal});
  if(path==='/admin/security'||path.startsWith('/admin/security/')){
    if(path==='/admin/security'&&request.method==='GET')return !security.enabled&&!recent?securityPage(owner,false,'','Your GitHub verification expired. Sign in again to set up your authenticator.',[],true):securityPage(owner,security.enabled);
    if(request.method!=='POST')return failure(405,'Method denied');
    let fields:URLSearchParams;
    try{fields=await form(request,env,owner);}catch{return securityPage(owner,security.enabled,'','This form expired or came from another site. Reload Owner verification and retry.');}
    if(!security.enabled&&!recent)return securityPage(owner,false,'','Your GitHub verification expired. Sign in again to set up your authenticator.',[],true);
    try{
      if(path==='/admin/security/setup'){const setup=await store('/owner-auth/enroll',{session:binding,principal,recent});return securityPage(owner,false,setup.secret);}
      if(path==='/admin/security/verify'){const result=await store('/owner-auth/verify',{session:binding,principal,recent,code:fields.get('code')});if(result.recoveryCodes?.length)return securityPage(owner,true,'','',result.recoveryCodes);return ownerRedirect(config(env).publicOrigin+'/admin');}
    }catch(error){
      const status=(error as {status?:number})?.status;
      if(status===429)return securityPage(owner,security.enabled,'','Too many code attempts. Wait ten minutes before trying again.',[],false,429);
      if(status===403&&path==='/admin/security/verify')return securityPage(owner,security.enabled,'','The code is invalid, expired or already used. Use the current time-based code. If setup is older than five minutes, start setup again.');
      if(status===403&&path==='/admin/security/setup')return securityPage(owner,security.enabled,'','Setup was not authorized. Refresh your owner GitHub sign-in before retrying.',[],true);
      return securityPage(owner,security.enabled,'',path==='/admin/security/setup'?'Authenticator setup is temporarily unavailable. No code was checked. Please retry shortly.':'Authenticator verification is temporarily unavailable. Please retry shortly.',[],false,503);
    }
    return failure(404,'Unavailable');
  }
  if(!security.verified)return new Response(null,{status:303,headers:{Location:config(env).publicOrigin+'/admin/security','Cache-Control':'no-store'}});
  let fields:URLSearchParams|null=null;
  try{if(request.method==='POST')fields=await form(request.clone(),env,owner);}catch{return failure(403,'Owner form denied');}
  if(path==='/admin/security-backups'){
    if(request.method!=='GET')return failure(405,'Method denied');
    if(url.search)return failure(400,'Unexpected dashboard parameters');
    const metric=(label:string,value:string,help:string)=>'<section class="panel owner-metric"><p class="metric-label">'+escaped(label)+'</p><strong>'+escaped(value)+'</strong><p class="footnote">'+escaped(help)+'</p></section>';
    const prototype='<p>The private backup-engine prototype has a scheduler, encrypted backup verification, remote-storage adapter and a read-only local owner dashboard. Its automated test workflow has passed.</p><p><a class="button neutral" href="https://github.com/pcremotecommander-code/pcrc-security-backup/tree/backup-engine-prototype" target="_blank" rel="noopener noreferrer">Open private backup project</a></p>';
    const boundary='<p class="notice" role="status">The backup prototype currently runs separately from the PCRC Cloudflare Worker. This page does not yet receive live scheduler or storage-provider telemetry. Values are deliberately shown as not connected rather than guessed.</p>';
    return page(heading('Security & backups','Private overview of PCRC backup readiness and production protection.')+boundary+'<div class="owner-grid">'+
      metric('Backup engine','Prototype ready','Private repository; automated prototype tests pass')+
      metric('Production scheduler','Not enabled','No recurring production job is installed')+
      metric('Independent storage','Not connected','No production storage credentials or bucket configured')+
      metric('Latest production backup','Not available','No production backup has been run through this system')+
      metric('Restore verification','Pending','Provider-backed clean-environment restore drill is required')+
      metric('Production changes','None','This integration has not changed production configuration')+
      '</div><div class="owner-columns">'+panel('Private backup engine',prototype)+panel('Owner access','<p>This page is shown only after the existing owner GitHub sign-in and authenticator verification checks have passed.</p><p>Backup keys, provider credentials and customer data are never displayed here.</p>')+'</div><div style="margin-top:20px">'+panel('Next integration gate','<ol><li>Build a signed, allowlisted status bridge from the backup runner to the owner Worker.</li><li>Authenticate the runner independently; reject replayed or stale status updates.</li><li>Display last successful run, failures, remote object counts, retention verification and cost only after provider evidence is available.</li><li>Complete a clean-environment restore drill before enabling production scheduling.</li></ol><p class="footnote">No backup, restore, delete, credential rotation or production action is available from this page.</p>')+'</div>','Security & backups',owner,'backups');
  }
  if(path==='/admin/analytics/refresh'&&fields){
    const job=await store('/owner-data/begin',{});
    const directory=await store('/directory/list',{...(job.after?{after:job.after}:{})});
    const accounts:any[]=[];for(let i=0;i<directory.ids.length;i+=5)accounts.push(...await Promise.all(directory.ids.slice(i,i+5).map(async(id:string)=>({id,status:await store('/device/status-summary',{},id)}))));
    const result=await store('/owner-data/batch',{id:job.id,after:job.after,accounts});return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }
  if(path==='/admin'&&request.method==='GET'){
    const month=url.searchParams.get('month')??new Date().toISOString().slice(0,7);if([...url.searchParams.keys()].some(key=>key!=='month')||!/^20\d{2}-(?:0[1-9]|1[012])$/.test(month))return failure(400,'Invalid month');
    const overview=await store('/owner-data/overview',{}),snapshot=overview.snapshot,totals=snapshot?.totals;
    const metric=(label:string,value:unknown,help:string)=>'<section class="panel owner-metric"><p class="metric-label">'+escaped(label)+'</p><strong>'+escaped(value===undefined?'—':Number(value).toLocaleString('en-US'))+'</strong><p class="footnote">'+escaped(help)+'</p></section>';
    const refresh='<form data-refresh-analytics method="post" action="/admin/analytics/refresh">'+csrf(owner)+button('Refresh analytics')+'<p data-refresh-status class="footnote" role="status">'+(snapshot?'Snapshot '+escaped(time(snapshot.measuredAt)):'Create the first complete snapshot')+'</p></form>';
    const joined=snapshot?.joined??{},now=new Date(),today=now.toISOString().slice(0,10),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
    const sum=(a:string,b:string)=>Object.entries(joined).filter(([day])=>day>=a&&day<b).reduce((n,[,v])=>n+Number(v),0);
    const weekStart=new Date(Date.now()-6*86400000).toISOString().slice(0,10),previousWeek=new Date(Date.now()-13*86400000).toISOString().slice(0,10),tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
    const thisMonth=today.slice(0,7)+'-01',previousMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString().slice(0,10);
    const growth=(label:string,current:number,previous:number)=>'<div class="chart-row"><span>'+label+'</span><meter min="0" max="'+Math.max(1,current,previous)+'" value="'+current+'" aria-label="'+label+' new accounts">'+current+'</meter><strong>'+current+'</strong></div><p class="footnote">'+(current-previous>=0?'+':'')+(current-previous)+' compared with the previous period</p>';
    const finance=await store('/owner-data/finance/get',{month}),revenue=finance.revenue;
    const financeRows=Object.entries(revenue?.currencies??{}).map(([currency,row]:[string,any])=>'<tr><th scope="row">'+escaped(currency)+'</th><td>'+escaped(money(row.collected,currency))+'</td><td>'+escaped(money(row.adjustments,currency))+'</td><td>'+escaped(row.earnings===null?'Pending':money(row.earnings,currency))+'</td><td>'+escaped(finance.costs[currency]===undefined?'Costs not recorded':row.earnings===null?'Pending':money(row.earnings-finance.costs[currency],currency))+'</td></tr>').join('');
    const financial='<form method="get" action="/admin"><label>Report month <input type="month" name="month" value="'+month+'" required></label> '+button('View month','neutral')+'</form>'+(revenue?'<p class="footnote">'+(revenue.complete?'Complete monthly scan':'Partial scan — continue before treating these as monthly totals')+' · '+revenue.count+' PCRC transactions · '+revenue.excluded+' unrelated or mixed-product transactions excluded · '+escaped(time(revenue.measuredAt))+'</p><div class="table-scroll"><table class="owner-table"><thead><tr><th>Currency</th><th>Collected</th><th>Adjustments</th><th>Net earnings</th><th>Estimated profit</th></tr></thead><tbody>'+financeRows+'</tbody></table></div>':'<p class="muted">No verified revenue snapshot for this month.</p>')+'<p class="footnote">Only completed transactions for the configured PCRC price. Currencies stay separate. Net earnings use Paddle fees and adjustments; estimated profit also subtracts the monthly costs you record below. This groups payments by billing month, including later adjustments; it is not a cash-flow statement.</p><form method="post" action="/admin/revenue/refresh">'+csrf(owner)+hidden('month',month)+button(revenue&&!revenue.complete?'Continue revenue scan':'Refresh revenue','neutral',billingApiReady(env)?'':'disabled')+'</form><form class="owner-cost" method="post" action="/admin/revenue/cost">'+csrf(owner)+hidden('month',month)+'<div class="owner-form-actions"><label>Currency <input name="currency" maxlength="3" pattern="[A-Z]{3}" placeholder="USD" required></label><label>Monthly costs <input name="amount" inputmode="decimal" placeholder="0.00" required></label>'+button('Save costs','neutral')+'</div></form>';
    return page(heading('Analytics','Accounts, connected computers and verified billing snapshots.',refresh)+'<div class="owner-grid">'+metric('Total accounts',totals?.users,'Complete directory snapshot')+metric('Signed-in accounts',totals?.signedIn,'At least one unexpired browser session')+metric('Online accounts',totals?.online,'At least one signed device relay online')+metric('Pro accounts',totals?.pro,(totals?.complimentary??0)+' complimentary grants')+'</div><div class="owner-columns">'+panel('New accounts',(snapshot?growth('Today',joined[today]??0,joined[yesterday]??0)+growth('Last 7 days',sum(weekStart,tomorrow),sum(previousWeek,weekStart))+growth('This month',sum(thisMonth,tomorrow),sum(previousMonth,thisMonth)):'<p>Refresh analytics to load account growth.</p>')+'<p class="footnote">UTC periods. '+(totals?.unknownJoined??0)+' older accounts have no recorded join date and are excluded from growth.</p>')+panel('Account mix','<div class="setting"><span>Free accounts</span><strong>'+(totals?.free??'—')+'</strong></div><div class="setting"><span>Active computers</span><strong>'+(totals?.devices??'—')+'</strong></div><a class="button neutral" href="/admin/users">Manage users</a>')+'</div><div style="margin-top:20px">'+panel('Monthly financials',financial)+'</div>','Analytics',owner,'operations');
  }
  if(path==='/admin/revenue/refresh'&&fields){try{await refreshRevenue(env,store,fields.get('month')??'',fetcher);}catch{return page(heading('Revenue unavailable','The last saved snapshot is preserved. Check your Paddle API configuration and retry explicitly.')+'<a href="/admin">Back to analytics</a>','Revenue unavailable',owner,'operations',503);}return ownerRedirect(config(env).publicOrigin+'/admin?month='+encodeURIComponent(fields.get('month')!));}
  if(path==='/admin/revenue/cost'&&fields){try{const currency=fields.get('currency')??'',amount=costAmount(fields.get('amount')??'',currency);await store('/owner-data/finance/cost',{month:fields.get('month'),currency,amount});}catch{return failure(400,'Enter a valid currency and cost amount');}return ownerRedirect(config(env).publicOrigin+'/admin?month='+encodeURIComponent(fields.get('month')!));}

  if(path==='/admin/users/action'&&fields){
    const account=fields.get('account')??'',found=await store('/directory/find',{query:account});if(found.id!==account)return failure(404,'Exact account not found');
    const action=fields.get('action');let completed=0,requested=0;
    if(action==='reset')return ownerReset(env,owner,account,store,fetcher);
    try{
      if(action==='pro'){
        const days=Number(fields.get('days'));if(!Number.isInteger(days)||days<0||days>365)return failure(400,'Choose 0 to remove a grant, or 1–365 days');
        await operator(env,'/operator/pro',{nonce:fields.get('nonce'),until:days?Date.now()+days*86400000:0,reason:'Owner complimentary access'},account);
      }else if(action==='revoke'||action==='release'){
        if(fields.get('confirmation')!==action.toUpperCase())return failure(400,'Type '+action.toUpperCase()+' to confirm');
        const data=await store('/device/list',{},account),ids=fields.getAll('device');
        if(!ids.length||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!data.devices.some((d:any)=>d.id===id)))return failure(400,'Select up to 20 computers belonging to this account');
        requested=ids.length;for(const id of ids){if(action==='release'){const released=await store('/device/release',{id},account);await store('/pairing/release',released);}else await store('/device/revoke',{id},account);completed++;}
      }else if(action==='delete'){
        if(account===env.ALLOWED_GITHUB_ID||fields.get('confirmation')!=='DELETE')return failure(403,'Confirm deletion of a member account');
        await store('/account/delete-start',{confirmation:'DELETE'},account);
        return page(heading('Account deletion started','Device access is blocked. Background cleanup will remove active account data. Files on the PC are preserved.')+'<a href="/admin/users">Back to users</a>','Deletion started',owner,'accounts',202);
      }else return failure(400,'Unknown user action');
    }catch{return page(heading('Action needs review',(requested?completed+' of '+requested+' device decisions confirmed. ':'')+'The remaining result could not be confirmed. Refresh user details before another request. Do not replay a refund or deletion.')+'<a href="/admin/users?user='+escaped(account)+'">Review account</a>','Action needs review',owner,'accounts',409);}
    return ownerRedirect(config(env).publicOrigin+'/admin/users?'+new URLSearchParams({user:account,saved:'1'}));
  }
  if(path==='/admin/users'&&request.method==='GET'){
    const q=(url.searchParams.get('q')??'').trim();if(q.length>100)return failure(400,'Search is too long');
    const listing=await store('/owner-data/users',{q,...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{})});
    const links=listing.users.map((u:any)=>'<li><a class="owner-user" data-open-user href="/admin/users?'+escaped(new URLSearchParams({q,user:u.id}).toString())+'"><span class="owner-avatar" aria-hidden="true">'+escaped((typeof u.login==='string'?u.login:u.id).slice(0,2).toUpperCase())+'</span><span>'+escaped(typeof u.login==='string'?u.login:'Account '+u.id)+'</span></a></li>').join('');
    let dialog='';const selected=url.searchParams.get('user');
    if(selected){const found=await store('/directory/find',{query:selected});if(found.id!==selected)return failure(404,'Exact account not found');
      const [data,meta,detail,target]=await Promise.all([store('/device/list',{},selected),store('/owner-data/meta',{id:selected}),operator(env,'/operator/detail',{},selected),store('/owner-data/email',{id:selected})]);
      const base=(action:string)=>'<form method="post" action="/admin/users/action">'+csrf(owner)+hidden('account',selected)+hidden('action',action);
      const devices=base('revoke')+'<label><input type="checkbox" data-select-devices> Select all displayed computers</label>'+data.devices.map((d:any)=>'<label class="owner-device"><input type="checkbox" name="device" value="'+escaped(d.id)+'"><span><strong>'+escaped(d.name)+'</strong><br><small>'+escaped(d.id)+'</small></span><span class="owner-badge '+(d.online===true?'':'offline')+'">'+(d.revoked?'Revoked':d.online===true?'Online':'Offline')+'</span></label>').join('')+'<label>Type REVOKE<input name="confirmation" autocomplete="off" required></label><div class="owner-form-actions">'+button('Revoke selected','danger')+'</div></form>';
      const pro=base('pro')+hidden('nonce',crypto.randomUUID())+'<p>Effective plan: <strong>'+escaped(data.plan)+'</strong>. '+(detail.grant?'Complimentary access until '+escaped(time(detail.grant.until))+'.':'No complimentary grant.')+'</p><p class="footnote">Grants do not create a paid subscription. Removing a grant does not cancel a paid subscription. On expiry or removal, Free keeps one active computer and revokes extra connections.</p><label>Days of complimentary Pro (0 removes the grant)<input name="days" type="number" min="0" max="365" value="30" required></label><div class="owner-form-actions">'+button('Update complimentary Pro')+'</div></form>';
      let history='<p>Billing history unavailable until the owner Paddle API is configured.</p>';
      if(billingApiReady(env)){try{const raw=JSON.stringify({accountId:selected,after:null}),stamp=String(Math.floor(Date.now()/1000)),{deviceKey}=await import('./policy.ts');const proof=await deviceKey(env.JAN_PROXY_KEY,'PCRC_BILLING_HISTORY_V1\n'+stamp+'\n'+raw);const response=await internalBillingHistory(new Request('https://pcrc-billing.internal/internal/billing/history',{method:'POST',headers:{'X-PCRC-Time':stamp,'X-PCRC-Proof':proof},body:raw}),env as any,fetcher);if(response.ok){const billing:any=await response.json();history=billing.rows.map((row:any)=>'<div class="setting"><div>'+escaped(row.amount)+'<p>'+escaped(row.at)+' · '+escaped(row.status)+'</p><small>'+escaped(row.id)+'</small></div></div>').join('')||'<p>No recorded payments.</p>';}}catch{}}
      dialog='<dialog open class="owner-dialog" data-owner-dialog aria-labelledby="user-heading"><header class="dialog-top"><div><p class="owner-kicker">User details</p><h2 id="user-heading">'+escaped(found.login||selected)+'</h2></div><a class="button neutral" data-dialog-close href="'+escaped(back(q))+'" aria-label="Close user details">Close</a></header><div class="dialog-body">'+(url.searchParams.get('saved')?notice(url.searchParams.get('saved')==='reset'?'The email provider accepted the password-reset request. Check the inbox. The password has not been changed.':'Action accepted. Current account details are shown below.'):'')+panel('Account','<dl><dt>Account ID</dt><dd>'+escaped(selected)+'</dd><dt>Created</dt><dd>'+escaped(time(meta.created))+'</dd><dt>Last sign-in</dt><dd>'+escaped(time(meta.lastLogin))+'</dd><dt>Plan</dt><dd>'+escaped(data.plan)+'</dd><dt>Computers</dt><dd>'+data.devices.length+'</dd></dl>')+'<details open><summary>Computers and access</summary><div>'+devices+'<p><a href="/admin/accounts?account='+escaped(selected)+'">Review account transfer</a></p></div></details><details><summary>Complimentary Pro</summary><div>'+pro+'</div></details><details><summary>Password reset</summary><div><p>Send a reset to the verified email already linked to this account. GitHub-only users reset their GitHub password at GitHub.</p>'+base('reset')+button('Send password-reset email','neutral',target.email?'':'disabled')+'</form></div></details><details><summary>Billing and subscriptions</summary><div>'+history+'<a class="button neutral" href="/admin/subscriptions?q='+escaped(selected)+'">Review cancellation or refund</a></div></details><details><summary>Recent website sign-ins</summary><div>'+meta.logins.map((at:number)=>'<p>'+escaped(time(at))+'</p>').join('')+(meta.logins.length?'':'<p>No sign-in history recorded yet.</p>')+'</div></details><details><summary>Delete account</summary><div><p>Permanent closure. Cancel subscriptions first. Personal files on the PC are not deleted.</p>'+base('delete')+'<label>Type DELETE<input name="confirmation" autocomplete="off" required></label>'+button('Start account deletion','danger',selected===env.ALLOWED_GITHUB_ID?'disabled':'')+'</form></div></details></div></dialog>';
    }
    return page(heading('User management','Search by username, account ID or indexed computer name. Open a user to manage access.')+'<form class="owner-search" method="get" action="/admin/users"><div class="field"><label for="user-search">Find a user</label><input id="user-search" name="q" value="'+escaped(q)+'" placeholder="Username, account ID or computer name" maxlength="100"></div>'+button('Search')+(q?'<a class="button neutral" href="/admin/users">Clear</a>':'')+'</form><h2>'+ (q?'Search results':'Latest users')+'</h2><ul class="owner-list">'+links+'</ul>'+(links?'':'<div class="panel owner-empty">No matches. Try the exact account ID. Older computer names appear after an analytics refresh.</div>')+(listing.next?'<a class="button neutral" href="/admin/users?'+escaped(new URLSearchParams({q,after:listing.next}).toString())+'">More users</a>':'')+dialog,'Users',owner,'accounts');
  }
  if(path==='/admin/support')return ownerSupport(request,env,owner,store,fields);
  return null;
}

async function ownerSupport(request:Request,env:Env,owner:Owner,store:OwnerStore,fields:URLSearchParams|null){
  const url=new URL(request.url);
  if(fields){const account=fields.get('account')??'',id=fields.get('ticket')??'',found=await store('/directory/find',{query:account});if(found.id!==account)return failure(404,'Account unavailable');await operator(env,'/operator/support/reply',{id,text:fields.get('text'),close:fields.get('close')==='yes'},account);return ownerRedirect(config(env).publicOrigin+'/admin/support?'+new URLSearchParams({account,ticket:id}));}
  const list=await store('/owner-data/support-index',{...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{})});
  let thread='';const account=url.searchParams.get('account'),id=url.searchParams.get('ticket');
  if(account&&id){const ticket=await operator(env,'/operator/support/get',{id},account);thread=panel(ticket.title,ticket.messages.map((m:any)=>'<div class="owner-thread" data-author="'+(m.author==='owner'?'owner':'user')+'"><strong>'+escaped(m.author==='owner'?'PCRC support':'User')+'</strong> · '+escaped(time(m.at))+'<p>'+escaped(m.text)+'</p></div>').join('')+'<form method="post" action="/admin/support">'+csrf(owner)+hidden('account',account)+hidden('ticket',id)+'<label>Reply<textarea name="text" maxlength="2000" rows="4" required></textarea></label><label><input type="checkbox" name="close" value="yes"> Close after replying</label><div class="owner-form-actions">'+button('Send reply')+'</div></form>');}
  return page(heading('Customer support','Private in-site threads. Replies are visible to the user in their support page.')+'<div class="owner-columns">'+panel('Recent tickets',list.tickets.map((t:any)=>'<p><a href="/admin/support?'+escaped(new URLSearchParams({account:t.accountId,ticket:t.id}).toString())+'">'+escaped(t.accountId)+' · '+escaped(time(t.created))+'</a></p>').join('')||'<p>No support tickets yet.</p>')+(thread||panel('Select a ticket','<p>Open a thread to read it and reply.</p>'))+'</div>'+(list.next?'<a href="/admin/support?after='+escaped(list.next)+'">Older tickets</a>':''),'Support',owner,'support');
}

export async function memberSupport(request:Request,env:Env,owner:Owner,accountId:string,store:OwnerStore):Promise<Response>{
  const url=new URL(request.url);if(request.method==='POST'){
    const fields=await form(request,env,owner);const id=fields.get('ticket');
    if(id)await store('/support/reply',{id,text:fields.get('text')},accountId);
    else{const ticket=await store('/support/create',{title:fields.get('title'),text:fields.get('text')},accountId);await store('/owner-data/support-index-add',{accountId,id:ticket.id,created:ticket.created});}
    return ownerRedirect(config(env).publicOrigin+'/devices/support');
  }
  const list=await store('/support/list',{},accountId),id=url.searchParams.get('ticket');let thread='';
  if(id){const ticket=await store('/support/get',{id},accountId);thread=panel(ticket.title,ticket.messages.map((m:any)=>'<div class="owner-thread"><strong>'+escaped(m.author==='owner'?'PCRC support':'You')+'</strong><p>'+escaped(m.text)+'</p></div>').join('')+'<form method="post" action="/devices/support">'+csrf(owner)+hidden('ticket',id)+'<label>Message<textarea name="text" maxlength="2000" required></textarea></label>'+button('Send message')+'</form>');}
  return portalPage(heading('Support','Send a message and read replies here. Keep passwords, tokens and verification codes out of messages.')+panel('Your requests',list.tickets.map((t:any)=>'<p><a href="/devices/support?ticket='+escaped(t.id)+'">'+escaped(t.title)+'</a> · '+escaped(t.status)+'</p>').join('')||'<p>No requests yet.</p>')+thread+panel('New request','<form method="post" action="/devices/support">'+csrf(owner)+'<label>Subject<input name="title" maxlength="100" required></label><label>Message<textarea name="text" rows="4" maxlength="2000" required></textarea></label>'+button('Create support request')+'</form>'),'Support',{owner,active:'support',headers:{'Referrer-Policy':'same-origin'}});
}
