// Local benchmark only. Never imported by src/index.ts or any deployment config.
import {JanDeviceStore} from '../src/device_store.ts';
import {proxyMcp} from '../src/policy.ts';

export class LocalFixtureStore extends JanDeviceStore {
  constructor(state,env){super(state,env);this.fixtureState=state;}
  async fetch(request){
    if(new URL(request.url).pathname==='/fixture/lease-expiries'){
      const leases=await this.fixtureState.storage.get('connected:accounts:v1')??{};
      return Response.json(Object.fromEntries(Object.entries(leases).map(([account,lease])=>[account,lease.expires])));
    }
    if(new URL(request.url).pathname==='/fixture/seed'){
      const {account,device}=await request.json();
      if(!/^\d{4}$/.test(account)||!/^[a-f0-9-]{36}$/.test(device))return new Response(null,{status:400});
      await this.fixtureState.storage.put({'account:owner:v1':account,active:device,
        devices:{...await this.fixtureState.storage.get('devices'),[device]:{id:device,ownerId:account,name:'Synthetic capacity fixture',revoked:false,capabilities:['read']}}});
      return new Response(null,{status:204});
    }
    return super.fetch(request);
  }
}

export default {fetch(request,env){
  // Models the already-validated identity boundary; this does not benchmark OAuth login.
  const account=request.headers.get('X-Test-Account');
  if(!/^\d{4}$/.test(account??''))return new Response(null,{status:403});
  return proxyMcp(request,env,{audience:env.JAN_PUBLIC_ORIGIN+'/mcp',userId:account,scope:['pcrc:read']},
    {accountId:account,authVersion:0});
}};
