// One ephemeral read-only OAuth/PKCE check. Credentials stay only in memory.
import {createServer} from 'node:http';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const base='https://pc-remote-commander.pcremotecommander.workers.dev';
const port=6276,redirect=`http://127.0.0.1:${port}/callback`;
const verifier=randomBytes(48).toString('base64url'),state=randomBytes(32).toString('base64url');
const report={started_at:new Date().toISOString(),public_gateway:base,read_only:true,passed:false,steps:[]};
const output=new URL('../work/public-oauth-validation.json',import.meta.url);
let client,started=false,finished=false;
function save(){writeFileSync(output,JSON.stringify(report,null,2));}
function page(response,status,text){response.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
  'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});response.end(text);}
async function jsonFetch(path,options={}){
  const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error(`Public endpoint ${path} returned HTTP ${response.status}`);
  return response.json();
}
async function rpc(token,name,args={},method='tools/call'){
  report.current_method=method==='tools/call'?name:method;
  const message={jsonrpc:'2.0',...(method.startsWith('notifications/')?{}:{id:randomUUID()}),method,
    params:method==='tools/call'?{name,arguments:args}:args};
  const response=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,
    'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify(message),signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error(`Authenticated MCP returned HTTP ${response.status}`);
  if(response.status===202||response.status===204)return null;
  const text=await response.text();
  const value=response.headers.get('Content-Type')?.includes('text/event-stream')?
    JSON.parse(text.split(/\r?\n/).find(line=>line.startsWith('data: ')).slice(6)):JSON.parse(text);
  if(value.error||value.result?.isError){
    const candidate=value.result?.structuredContent?.error_code??value.result?.structuredContent?.data?.error_code;
    if(typeof candidate==='string'&&/^[A-Z_]{3,48}$/.test(candidate))report.remote_error_code=candidate;
    if(typeof value.error?.code==='number')report.rpc_error_code=value.error.code;
    throw Error('Remote tool returned an error; see sanitized method/error code in report');
  }
  return value.result;
}
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,redirect);
  if(request.headers.host!==`127.0.0.1:${port}`){page(response,403,'Host denied');return;}
  if(url.pathname==='/start'&&!started){
    started=true;
    const params=new URLSearchParams({client_id:client.client_id,response_type:'code',redirect_uri:redirect,
      scope:'pcrc:read',state,resource:base+'/mcp',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
    response.writeHead(303,{Location:base+'/authorize?'+params,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});response.end();return;
  }
  if(url.pathname==='/callback'&&!finished){
    finished=true;
    try{
      if(url.searchParams.get('state')!==state||!url.searchParams.get('code'))throw Error('OAuth callback denied or incomplete');
      const token=await jsonFetch('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,
          code:url.searchParams.get('code'),code_verifier:verifier,resource:base+'/mcp'})});
      if(!token.access_token)throw Error('No OAuth token returned');
      report.steps.push('OAuth authorization code and PKCE exchange passed');
      const initialized=await rpc(token.access_token,'',{
        protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'pcrc-release-qa',version:'1.0.0'}},'initialize');
      if(!initialized?.protocolVersion)throw Error('MCP initialization did not return a protocol version');
      await rpc(token.access_token,'',{},'notifications/initialized');
      report.steps.push('MCP initialize handshake passed');
      const result=await rpc(token.access_token,'get_connection_status');
      report.steps.push('Public status tool completed');
      const diagnostic=await rpc(token.access_token,'run_diagnostic',{name:'python_version'});
      report.steps.push('Public HTTPS authenticated status and harmless diagnostic completed');
      report.status_result_received=!!result;report.diagnostic_result_received=!!diagnostic;
      token.access_token=null;token.refresh_token=null;
      report.passed=true;
    }catch(error){report.error=error instanceof Error?error.message:'Public OAuth test failed';process.exitCode=1;}
    report.finished_at=new Date().toISOString();save();
    response.writeHead(303,{Location:'/done','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});response.end();
    console.log(JSON.stringify(report));return;
  }
  if(url.pathname==='/done'){
    page(response,200,report.passed?'<h1>PCRC public connection test passed</h1><p>Read-only status and Python diagnostic completed through the public gateway. You may close this tab.</p>':
      '<h1>PCRC public connection test did not pass</h1><p>The local report contains a sanitized error. You may close this tab.</p>');
    setTimeout(()=>server.close(),500);return;
  }
  page(response,404,'Test is not active here');
});
try{
  client=await jsonFetch('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'PCRC release QA - read only',redirect_uris:[redirect],grant_types:['authorization_code'],
    response_types:['code'],token_endpoint_auth_method:'none'})});
  server.listen(port,'127.0.0.1',()=>console.log(`Read-only browser test ready: http://127.0.0.1:${port}/start`));
  server.on('error',()=>{report.error='Local callback listener could not start';save();process.exitCode=1;});
  save();setTimeout(()=>{if(!finished){report.error='Browser authorization not completed within 10 minutes';save();process.exitCode=1;}server.close();},600000).unref();
}catch(error){report.error=error instanceof Error?error.message:'Public registration failed';save();console.log(JSON.stringify(report));process.exitCode=1;}
