(() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const control = document.querySelector('#reduce-motion');
  let manual = false;
  let animations;
  try { manual = localStorage.getItem('pcrc-reduce-motion') === 'true'; } catch {}

  function applyMotion() {
    animations?.revert();
    animations = undefined;
    const reduce = preference.matches || manual;
    document.documentElement.dataset.motion = reduce ? 'off' : 'on';
    if (control) {
      control.checked = reduce;
      control.disabled = preference.matches;
    }
    for (const svg of document.querySelectorAll('svg.network-lines')) {
      if (reduce) svg.pauseAnimations?.();
      else svg.unpauseAnimations?.();
    }
    if (reduce) {
      for (const video of document.querySelectorAll('video[loop]')) {
        video.autoplay = false;
        video.pause();
      }
      return;
    }
    if (!window.gsap || !window.ScrollTrigger) return;
    const {gsap, ScrollTrigger} = window;
    gsap.registerPlugin(ScrollTrigger);
    animations = gsap.matchMedia();
    try {
      animations.add({mobile: '(max-width: 639px)', desktop: '(min-width: 640px)', motion: '(prefers-reduced-motion: no-preference)'}, (context) => {
        if (!context.conditions.motion) return;
        const mobile = context.conditions.mobile;
        const sections = document.querySelectorAll('main section.content, main section.section, .guide-body .guide-block, .guide-body .instructions, main .example, main .help, main .prompt-band');
        for (const section of sections) {
          const headings = section.querySelectorAll(':scope > h2, :scope > .eyebrow, :scope > .wrap > h2, :scope > .wrap > .eyebrow, :scope > div > h2');
          if (headings.length) gsap.from(headings, {y: mobile ? 14 : 28, opacity: .35, duration: .7, stagger: .07, ease: 'power3.out', scrollTrigger: {trigger: section, start: 'top 88%', once: true}});
        }
        for (const group of document.querySelectorAll('.site-home .cards, .client-guide-grid, .directory-grid, .site-footer .footer-grid')) {
          gsap.from(group.children, {y: mobile ? 16 : 36, opacity: .45, duration: .65, stagger: mobile ? .04 : .08, ease: 'power3.out', scrollTrigger: {trigger: group, start: 'top 90%', once: true}});
        }
        const network = document.querySelector('#connection-map .network');
        if (network) {
          gsap.from(network.querySelectorAll('.network-clients > div, .network-core, .network-tools > span'), {y: 20, opacity: .4, duration: .7, stagger: .08, ease: 'power3.out', scrollTrigger: {trigger: network, start: 'top 80%', once: true}});
          if (!mobile) {
            for (const path of network.querySelectorAll('.network-lines > path')) {
              const length = path.getTotalLength();
              gsap.fromTo(path, {strokeDasharray: length, strokeDashoffset: length}, {strokeDashoffset: 0, ease: 'none', scrollTrigger: {trigger: network, start: 'top 85%', end: 'bottom 55%', scrub: 1}});
            }
          }
        }
        gsap.to(document.documentElement, {'--page-progress': 1, ease: 'none', scrollTrigger: {trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: true}});
      });
      animations.add('(min-width: 1024px) and (prefers-reduced-motion: no-preference)', () => {
        const film = document.querySelector('.hero-film');
        if (film) gsap.fromTo(film, {scale: .97}, {scale: 1, ease: 'none', scrollTrigger: {trigger: film, start: 'top bottom', end: 'center center', scrub: 1}});
        const network = document.querySelector('#connection-map .network');
        if (network) gsap.fromTo(network, {y: 24}, {y: -24, ease: 'none', scrollTrigger: {trigger: network, start: 'top bottom', end: 'bottom top', scrub: 1}});
      });
    } catch {
      animations?.revert();
      animations = undefined;
    }
  }
  control?.addEventListener('change', () => {
    manual = control.checked;
    try { localStorage.setItem('pcrc-reduce-motion', String(manual)); } catch {}
    applyMotion();
  });
  preference.addEventListener('change', applyMotion);
  applyMotion();
  for (const region of document.querySelectorAll('.table-wrap, .table-scroll')) {
    region.tabIndex = 0;
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Scrollable information table');
  }
  for (const detail of document.querySelectorAll('details')) {
    detail.addEventListener('toggle', () => window.ScrollTrigger?.refresh());
  }
  // ScrollTrigger's load refresh can interrupt the browser's initial anchor jump.
  window.addEventListener('load', () => {
    if (!window.location.hash || window.location.hash.includes(':~:')) return;
    let target;
    try { target = document.getElementById(decodeURIComponent(window.location.hash.slice(1))); } catch { return; }
    if (target) window.requestAnimationFrame(() => target.scrollIntoView({behavior: 'instant', block: 'start'}));
  }, {once: true});
})();
