const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
for (const picker of document.querySelectorAll('.prompt-picker')) {
  const items = [...picker.querySelectorAll('details')];
  if (!items.length) continue;
  const tabs = document.createElement('div');
  tabs.className = 'prompt-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Prompt categories');
  const panel = document.createElement('div');
  panel.className = 'prompt-panel';
  panel.setAttribute('role', 'tabpanel');
  const buttons = items.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `prompt-tab-${index}`;
    button.setAttribute('role', 'tab');
    button.textContent = item.querySelector('summary').textContent;
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = (next + items.length) % items.length;
      select(target);
      buttons[target].focus();
    });
    tabs.append(button);
    return button;
  });
  function select(index) {
    buttons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', buttons[index].id);
    panel.replaceChildren(items[index].querySelector('pre').cloneNode(true));
  }
  picker.replaceChildren(tabs, panel);
  select(0);
}
for (const video of document.querySelectorAll('.site-guide .film video, .site-info .local-film video')) {
  const track = video.textTracks[0];
  if (!track) continue;
  track.mode = 'hidden';
  const caption = document.createElement('div');
  caption.className = 'live-subtitle';
  caption.setAttribute('aria-live', 'polite');
  const step = document.createElement('span');
  step.className = 'subtitle-step';
  const text = document.createElement('p');
  text.className = 'subtitle-text';
  step.textContent = 'STEP 01';
  text.textContent = 'Follow each step as the video plays.';
  caption.append(step, text);
  video.after(caption);
  let currentCue = -1;
  const updateCaption = () => {
    const cues = Array.from(track.cues || []);
    if (!cues.length) return;
    const active = track.activeCues?.[0] || cues.find(cue => video.currentTime >= cue.startTime && video.currentTime < cue.endTime) || cues[0];
    const index = cues.indexOf(active);
    if (index === currentCue) return;
    currentCue = index;
    step.textContent = `STEP ${String(index + 1).padStart(2, '0')} / ${String(cues.length).padStart(2, '0')}`;
    text.textContent = active.text;
    caption.classList.remove('is-entering');
    requestAnimationFrame(() => caption.classList.add('is-entering'));
  };
  track.addEventListener('cuechange', updateCaption);
  video.querySelector('track')?.addEventListener('load', updateCaption);
  video.addEventListener('timeupdate', updateCaption);
  video.addEventListener('seeked', updateCaption);
  updateCaption();
}
const workflows = document.querySelectorAll('video[data-workflow]');
for (const video of workflows) {
  const toggle = video.closest('figure').querySelector('[data-workflow-toggle]');
  toggle.hidden = false;
  video.addEventListener('play', () => { toggle.textContent = 'Pause animation'; });
  video.addEventListener('pause', () => { toggle.textContent = 'Play animation'; });
  toggle.addEventListener('click', () => {
    video.dataset.manual = '';
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
}
if (!reducedMotion.matches) {
  for (const video of document.querySelectorAll('video[muted][loop]:not([data-workflow])')) {
    video.muted = true;
    video.play().catch(() => {});
  }
  if ('IntersectionObserver' in window) {
    const previews = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        previews.unobserve(entry.target);
        if (!reducedMotion.matches && !('manual' in entry.target.dataset)) {
          entry.target.play().catch(() => {});
        }
      }
    }, { threshold: .35 });
    for (const video of workflows) previews.observe(video);
  }
}
