// Best-effort return only after a website action has settled. Never submits an approval.
(() => {
  const page=document.querySelector('[data-action-return]');
  if(!page)return;
  const id=page.dataset.actionId,status=page.dataset.actionStatus;
  if(!/^[a-f0-9-]{36}$/.test(id??''))return;
  const key='pcrc-action-return:'+id;
  const trusted=new Set(['chatgpt.com','claude.ai','gemini.google.com','copilot.microsoft.com','www.perplexity.ai']);
  function safeReturn(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&trusted.has(url.hostname)?url.origin+url.pathname:null;}catch{return null;}}
  if(status==='pending'){
    const target=safeReturn(document.referrer);
    if(target)try{sessionStorage.setItem(key,target);}catch{}
    return;
  }
  if(!['completed','denied'].includes(status))return;
  const row=document.createElement('div');row.className='action-row';
  const close=document.createElement('button');close.type='button';close.className='button primary';close.textContent='Return to your assistant';
  const note=document.createElement('p');note.className='footnote';note.setAttribute('role','status');note.textContent='Returning to your chat. If this tab stays open, switch back to your assistant.';
  const finish=()=>{try{window.opener?.focus();}catch{}try{window.close();}catch{}};
  close.addEventListener('click',finish);row.append(close);
  let target;try{target=safeReturn(sessionStorage.getItem(key));sessionStorage.removeItem(key);}catch{}
  if(target){const link=document.createElement('a');link.className='button neutral';link.href=target;link.rel='noreferrer';link.textContent='Open previous chat';row.append(link);}
  page.append(row,note);
  if(window.location.hash==='#return-to-chat')setTimeout(finish,1000);
})();
