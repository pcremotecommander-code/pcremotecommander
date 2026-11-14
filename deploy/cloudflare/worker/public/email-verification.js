// Cross-tab notices never authorize login; the server confirms the session and form binding.
(() => {
  const page=document.querySelector('[data-email-verification]');
  if(!page)return;
  const flow=page.dataset.flow,phase=page.dataset.emailVerification;
  if(!/^[A-Za-z0-9_-]{43}$/.test(flow??''))return;
  const status=page.querySelector('[data-verification-status]');
  let channel;try{channel=new BroadcastChannel('pcrc-email-verification');}catch{}
  const notify=type=>{try{channel?.postMessage({type,flow});}catch{}};
  const navigate=target=>{
    if(typeof target!=='string'||!target.startsWith('/')||target.startsWith('//'))return;
    const url=new URL(target,location.origin);
    if(url.origin===location.origin)location.replace(url.pathname+url.search);
  };
  if(phase==='waiting'){
    let checking=false,finished=false;
    const deadline=Date.now()+15*60*1000;
    const check=async()=>{
      if(checking||finished)return;
      if(Date.now()>deadline){finished=true;if(status)status.textContent='Still waiting? Open the email link, then sign in to continue.';return;}
      checking=true;
      try{
        const response=await fetch('/devices/email/verification-status',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({flow})});
        if(response.ok){const result=await response.json();if(result.verified===true&&typeof result.target==='string'){finished=true;notify('ready');navigate(result.target);}}
      }catch{}finally{checking=false;}
    };
    if(channel)channel.onmessage=event=>{if(event.data?.flow===flow&&event.data?.type==='verified')check();};
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')check();});
    const timer=setInterval(()=>{if(finished)clearInterval(timer);else check();},10000);
    check();
    return;
  }
  if(phase!=='complete')return;
  let returned=false;
  const close=()=>{try{window.opener?.focus();}catch{}try{window.close();}catch{}if(status)status.textContent='Your dashboard is ready in the original tab. If this tab stays open, you can close it.';};
  page.querySelector('[data-verification-close]')?.addEventListener('click',close);
  if(channel)channel.onmessage=event=>{if(event.data?.flow===flow&&event.data?.type==='ready'){returned=true;if(status)status.textContent='Your original tab is opening the dashboard.';setTimeout(close,300);}};
  notify('verified');
  setTimeout(()=>{if(!returned)notify('verified');},1000);
  // Browsers can block tab closing, and the original tab may no longer exist.
  setTimeout(()=>{if(!returned)navigate(page.dataset.target);},4000);
})();
