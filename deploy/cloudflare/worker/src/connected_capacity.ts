import {authenticatedAccountId} from './account_identity.ts';

export const MAX_CONNECTED_ACCOUNTS=200;
const TTL=60000;
const KEY='connected:accounts:v1';
type Grants=Record<string,{token:string;expires:number}>;
function prune(grants:Grants,now:number){for(const [id,grant]of Object.entries(grants))if(grant.expires<=now)delete grants[id];}
async function save(storage:DurableObjectStorage|DurableObjectTransaction,grants:Grants){
  if(!Object.keys(grants).length){await storage.delete(KEY);return;}
  await storage.put(KEY,grants);
  await storage.setAlarm(Math.min(...Object.values(grants).map(g=>g.expires)));
}
// Only the authenticated account DO calls this service object; there is no public route.
export async function connectedCapacity(request:Request,storage:DurableObjectStorage):Promise<Response>{
  if(request.method!=='POST')return new Response(null,{status:405});
  let body:{action:string;account:string;token:string};
  try{
    const raw=await request.text();if(raw.length>256)throw Error();body=JSON.parse(raw);
    if(Object.keys(body).sort().join(',')!=='account,action,token'||
      !['acquire','renew','release'].includes(body.action)||!authenticatedAccountId(body.account)||
      typeof body.token!=='string'||!/^[a-f0-9-]{36}$/.test(body.token))throw Error();
  }catch{return new Response(null,{status:400});}
  return storage.transaction(async tx=>{
    const now=Date.now(),grants=await tx.get<Grants>(KEY)??{};prune(grants,now);
    const current=grants[body.account];
    if(body.action==='acquire'){
      if(!current&&Object.keys(grants).length>=MAX_CONNECTED_ACCOUNTS){await save(tx,grants);return new Response(null,{status:429,headers:{'Retry-After':'30'}});}
      grants[body.account]={token:body.token,expires:now+TTL};
    }else if(body.action==='renew'){
      if(!current||current.token!==body.token){await save(tx,grants);return new Response(null,{status:409});}
      current.expires=now+TTL;
    }else if(current?.token===body.token)delete grants[body.account];
    await save(tx,grants);
    return body.action==='release'?new Response(null,{status:204}):Response.json({expires:grants[body.account].expires});
  });
}
export async function expireConnectedCapacity(storage:DurableObjectStorage){
  await storage.transaction(async tx=>{const grants=await tx.get<Grants>(KEY);if(grants){prune(grants,Date.now());await save(tx,grants);}});
}

export class ConnectedAccountLease{
  private token='';private expires=0;private pending:Promise<number>|null=null;
  private renewal:ReturnType<typeof setTimeout>|null=null;
  private deadline:ReturnType<typeof setTimeout>|null=null;
  private namespace:DurableObjectNamespace;private account:string;private expired:()=>void;
  constructor(namespace:DurableObjectNamespace,account:string,expired:()=>void){this.namespace=namespace;this.account=account;this.expired=expired;}
  get valid(){return !!this.token&&Date.now()<this.expires;}
  private async send(action:string,token:string){
    return this.namespace.get(this.namespace.idFromName('service:connected-capacity:v1')).fetch('https://internal.invalid/capacity/account',
      {method:'POST',body:JSON.stringify({action,account:this.account,token}),signal:AbortSignal.timeout(5000)});
  }
  async acquire():Promise<number>{
    if(this.valid)return 200;
    if(this.pending)return this.pending;
    const token=crypto.randomUUID();this.token=token;
    this.pending=this.grant('acquire',token).finally(()=>{this.pending=null;});
    return this.pending;
  }
  private async grant(action:string,token:string):Promise<number>{
    try{
      const response=await this.send(action,token);
      if(this.token!==token)return 503;
      if(response.status!==200){if(action==='renew')this.fail();return response.status===429?429:503;}
      const {expires}=await response.json() as {expires:number};
      if(this.token!==token)return 503;
      if(!Number.isSafeInteger(expires)||expires<=Date.now()+1000||expires>Date.now()+TTL)throw Error();
      // Stop locally before the shared slot expires, even if renewal hangs or fails.
      this.expires=expires-1000;
      if(this.renewal!==null)clearTimeout(this.renewal);if(this.deadline!==null)clearTimeout(this.deadline);
      this.deadline=setTimeout(()=>this.fail(),this.expires-Date.now());
      this.renewal=setTimeout(()=>{void this.grant('renew',token);},20000);
      return 200;
    }catch{if(this.token===token)this.fail();return 503;}
  }
  private fail(){this.stop();this.expired();}
  stop(){
    const token=this.token;this.token='';this.expires=0;
    if(this.renewal!==null)clearTimeout(this.renewal);if(this.deadline!==null)clearTimeout(this.deadline);
    this.renewal=null;this.deadline=null;
    if(token)void this.send('release',token).catch(()=>{});
  }
}
