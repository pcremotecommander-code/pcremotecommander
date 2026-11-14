const heroVideo = document.querySelector('#hero-video');
if (heroVideo) {
  const hero = document.querySelector('.hero-motion');
  const sound = document.querySelector('#hero-sound');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const syncSound = () => {
    sound.textContent = heroVideo.muted ? 'Play with sound' : 'Mute sound';
    sound.setAttribute('aria-pressed', String(!heroVideo.muted));
  };
  const syncMotion = () => hero.classList.toggle('motion-paused', heroVideo.paused);
  heroVideo.addEventListener('volumechange', syncSound);
  heroVideo.addEventListener('play', syncMotion);
  heroVideo.addEventListener('pause', syncMotion);
  sound.addEventListener('click', async () => {
    const enableSound = heroVideo.muted;
    heroVideo.muted = !enableSound;
    if (enableSound) {
      heroVideo.currentTime = 0;
      try { await heroVideo.play(); }
      catch { heroVideo.muted = true; }
    }
    syncSound();
  });
  motionPreference.addEventListener('change', () => {
    if (motionPreference.matches) {
      heroVideo.autoplay = false;
      heroVideo.pause();
    }
  });
  heroVideo.muted = true;
  syncSound();
  syncMotion();
  if (!motionPreference.matches) {
    heroVideo.autoplay = true;
    heroVideo.play().catch(syncMotion);
  }
}
