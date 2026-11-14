/** Only human dashboard routes may be carried through sign-in. Never retain credentials or external URLs. */
export function dashboardReturn(value:unknown):string|null {
  if(typeof value!=='string'||value.length>256)return null;
  return /^\/devices(?:\/(?:settings|plan|account|billing\/history))?$/.test(value)||
    /^\/devices\/connect(?:\?step=(?:copy|run|assistant|verify)(?:&os=(?:windows|linux|macos))?(?:&client=(?:chatgpt|claude|cursor))?)?$/.test(value)||
    /^\/devices\/assistant(?:\?client=(?:chatgpt|claude|cursor))?$/.test(value)||
    /^\/devices\/usage(?:\?range=(?:today|week|last-week|months))?$/.test(value)?value:null;
}

export function signInReturn(value:unknown):string|null {
 return dashboardReturn(value)??(typeof value==='string'&&(/^\/(?:devices\/approve\?id=|consent\?handle=)[A-Za-z0-9_-]{43}$/.test(value)||/^\/devices\/actions\?id=[a-f0-9-]{36}$/.test(value)||/^\/devices\/plan\?_ptxn=txn_[a-z0-9]{26}$/.test(value))?value:null);
}
