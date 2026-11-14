for (const chapters of document.querySelectorAll('.lesson-chapters')) {
  const video = chapters.closest('figure').querySelector('video');
  const track = video.textTracks[0];
  let localClip;
  async function jump(time) {
    const playing = !video.paused;
    if (!localClip) {
      // The static host can return a full MP4 for byte-range requests.
      localClip = (async () => {
        const response = await fetch(video.querySelector('source').src);
        if (!response.ok) throw new Error('Video unavailable');
        const url = URL.createObjectURL(await response.blob());
        await new Promise((resolve, reject) => {
          video.addEventListener('loadedmetadata', resolve, { once: true });
          video.addEventListener('error', reject, { once: true });
          video.src = url;
        });
      })();
    }
    try {
      await localClip;
      video.currentTime = time;
      if (playing) await video.play();
    } catch {
      localClip = null;
      video.currentTime = time;
    }
  }
  function build() {
    if (!track.cues?.length || chapters.childElementCount) return;
    const names = chapters.dataset.chapters.split('|');
    Array.from(track.cues).forEach((cue, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = names[index] || 'Step ' + (index + 1);
      button.addEventListener('click', () => jump(cue.startTime + 0.02));
      chapters.append(button);
    });
    function highlight() {
      const cue = track.activeCues?.[0];
      const index = Array.from(track.cues).indexOf(cue);
      Array.from(chapters.children).forEach((button, i) => {
        if (i === index) button.setAttribute('aria-current','step');
        else button.removeAttribute('aria-current');
      });
    }
    track.addEventListener('cuechange', highlight);
    highlight();
  }
  video.querySelector('track').addEventListener('load', build);
  build();
}
for (const demo of document.querySelectorAll('.lesson-console')) {
  const screen = demo.querySelector('pre');
  const button = demo.querySelector('button');
  const lines = 'You   List the files in my workspace.\n\nPS>   Get-ChildItem -Name\n      notes.txt\n      report.csv\n\nPCRC  Found 2 files.';
  let frame = 0, timer;
  function tick() {
    screen.textContent = lines.slice(0, Math.min(frame, lines.length));
    frame = (frame + 2) % (lines.length + 90);
  }
  function toggle(start) {
    clearInterval(timer);
    timer = start ? setInterval(tick, 65) : null;
    button.textContent = start ? 'Pause demo' : 'Play demo';
  }
  screen.textContent = lines;
  const observer = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    observer.disconnect();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && !button.dataset.manual) toggle(true);
  });
  observer.observe(demo);
  button.textContent = 'Play demo';
  button.addEventListener('click', () => { button.dataset.manual = '1'; toggle(!timer); });
}
