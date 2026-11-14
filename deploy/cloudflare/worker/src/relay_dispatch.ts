/** Internal-only relay dispatch. Caller MUST have passed MCP OAuth owner/scope checks. */
import {validateRelayRequest} from './relay_protocol.ts';
import type {JanRelaySession} from './relay_session.ts';
import {required,developmentTools} from '../../../mcp-task-server/src/task-capabilities.ts';
type Device={revoked?:unknown;capabilities?:unknown};
export async function dispatchSelected(
  input:unknown,
  activeId:string|null,
  devices:Record<string,Device>,
  sessionFor:(id:string)=>Pick<JanRelaySession,'online'|'forward'>|null
):Promise<Response> {
  if(!activeId||!devices[activeId]||devices[activeId].revoked===true)
    return Response.json({error:'No selected approved device'},{status:503});
  let message;
  try {message=validateRelayRequest(input);}catch{return Response.json({error:'Invalid relay request'},{status:400});}
  if(message.control&&(!Array.isArray(devices[activeId].capabilities)||!(devices[activeId].capabilities as unknown[]).includes('control'))) {
    const method=(JSON.parse(message.payload) as {method:string}).method;
    if(!['tools/list','resources/list','resources/templates/list'].includes(method))
      return Response.json({error:'Device capability denied'},{status:403});
    message={...message,control:false};
  }
  if(message.control) {
    const rpc=JSON.parse(message.payload);
    const discovery=['tools/list','resources/list','resources/templates/list'].includes(rpc.method);
    const disable=rpc.method==='tools/call'&&rpc.params?.name==='jan_disable_control'&&['files','commands','browser','desktop'].some(cap=>(devices[activeId].capabilities as unknown[]).includes(cap));
    if(rpc.method==='tools/call'&&developmentTools.has(rpc.params?.name)&&!(devices[activeId].capabilities as unknown[]).includes('files'))return Response.json({error:'Device capability denied'},{status:403});
    const capability=rpc.method==='tools/call'&&typeof rpc.params?.name==='string'&&Object.hasOwn(required,rpc.params.name)?required[rpc.params.name]
      :rpc.method==='resources/read'&&typeof rpc.params?.uri==='string'&&/^app:\/\/pcrc\/processes\/[A-Za-z0-9_-]+$/.test(rpc.params.uri)?'commands':undefined;
    if(!discovery&&!disable&&(!capability||!(devices[activeId].capabilities as unknown[]).includes(capability)))
      return Response.json({error:'Device capability denied'},{status:403});
  }
  const session=sessionFor(activeId);
  if(!session?.online)return Response.json({error:'Selected device offline'},{status:503});
  try {
    const reply=await session.forward(message);
    return Response.json(reply,{headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    const reason=error instanceof Error&&['Device offline','Relay busy','Duplicate request','Relay timeout','Relay send failed','Device disconnected'].includes(error.message)?error.message:'Invalid relay reply';
    console.warn('PC_REMOTE_RELAY_DISPATCH',JSON.stringify({reason}));
    if(reason==='Relay busy') {
      const rpc=JSON.parse(message.payload);
      const identified=typeof rpc.id==='string'||typeof rpc.id==='number';
      return Response.json({type:'response',request_id:message.request_id,status:identified?200:204,payload:identified?JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32001,message:'PCRC is busy. This request was not executed. Wait for active requests to finish before starting another.',data:{error_code:'LOCAL_BUSY',executed:false,automatic_retry:false}}}):''},{headers:{'Cache-Control':'no-store'}});
    }
    return Response.json({error:'Device did not complete request; outcome unknown, do not retry mutations automatically'},{status:503});
  }
}
