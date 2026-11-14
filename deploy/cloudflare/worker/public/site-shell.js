(() => {
  const menu=document.querySelector('header.pcrc-island');
  if (!menu) return;
  let last=window.scrollY;
  const show=()=>menu.classList.remove('is-away');
  window.addEventListener('scroll',()=>{
    const pos=Math.max(0,window.scrollY);
    if(Math.abs(pos-last)<6 && pos>10)return;
    const keep=menu.querySelector('details[open],:focus-visible');
    menu.classList.toggle('is-away',pos>90 && pos>last && !keep);
    last=pos;
  },{passive:true});
  menu.addEventListener('focusin',show);
  menu.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      const open=menu.querySelector('details[open]');
      if(open){open.open=false;open.querySelector('summary').focus();}
    }
  });
  document.addEventListener('click',event=>{
    if(!menu.contains(event.target)||event.target.closest('a'))menu.querySelectorAll('details[open]').forEach(el=>el.open=false);
  });
})();
