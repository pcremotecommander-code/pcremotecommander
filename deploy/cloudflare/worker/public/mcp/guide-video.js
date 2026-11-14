const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
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
