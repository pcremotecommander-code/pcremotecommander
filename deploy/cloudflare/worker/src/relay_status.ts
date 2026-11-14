/** Call only after authenticated dispatch returns a validated relay envelope. */
export function verifiedRelayStatus(reply:any,call:any):void {
  const result=reply?.result,value=result?.structuredContent,data=value?.data;
  if(call?.method!=='tools/call'||!['get_connection_status','get_capabilities'].includes(call.params?.name)||reply?.id!==call.id||reply.error||result?.isError||value?.ok!==true||!data||typeof data!=='object'||Array.isArray(data))return;
  const original=JSON.stringify(value),previous=value.summary;
  data.backend_transport=data.backend_transport??data.transport??null;
  data.remote_transport='secure-websocket-relay';
  data.remote_enabled=true;
  data.live_remote_verified=true;
  data.connection_verification='This call completed through the authenticated public gateway and selected device relay. This does not establish long-term stability or a complete account-isolation audit.';
  data.connection_details={...(typeof data.connection_details==='object'&&!Array.isArray(data.connection_details)?data.connection_details:{}),backend_transport:data.backend_transport,remote_verification:data.connection_verification};
  value.summary='Public gateway and computer relay verified for this call';
  if(Array.isArray(result.content))result.content=result.content.filter((item:any)=>item?.type!=='text'||item.text!==original).map((item:any)=>item?.type==='text'&&item.text===previous?{...item,text:value.summary}:item);
}
