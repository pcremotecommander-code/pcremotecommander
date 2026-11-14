/** Compatibility for MCP clients that consume text but ignore structuredContent. */
export function includeTextResult<T extends {structuredContent?:unknown;content?:Array<{type:string;text?:string}>}>(result:T):T {
  const details=result.structuredContent;
  if(!details||typeof details!=='object'||Array.isArray(details))return result;
  let text=JSON.stringify(details);
  if(new TextEncoder().encode(text).length>65536){
    const data=details as {ok?:unknown;summary?:unknown};
    text=JSON.stringify({ok:typeof data.ok==='boolean'?data.ok:undefined,summary:typeof data.summary==='string'?data.summary.slice(0,3000):'PCRC result',text_result_truncated:true,detail:'Detailed result exceeds the text compatibility limit. Request a smaller range or page.'});
  }
  const content=result.content??[];
  if(!content.some(item=>item.type==='text'&&item.text===text))result.content=[...content,{type:'text',text}];
  return result;
}
