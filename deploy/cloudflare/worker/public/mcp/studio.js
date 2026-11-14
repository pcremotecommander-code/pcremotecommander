const lab = document.querySelector('.workflow-lab');
if (lab) {
  const scenarios = [
    ['List files', 'Which files are in my workspace?', 'dir /b /a:-d', 'notes.txt\nreport.csv', 'I found two files in your workspace: notes.txt and report.csv.'],
    ['Find a report', 'Is there a CSV report in this folder?', 'dir /b /a:-d *.csv', 'report.csv', 'Yes. I found report.csv in the current folder.'],
    ['Check Node.js', 'Which version of Node.js is on this PC?', 'node --version', 'v22.14.0', 'This PC is running Node.js v22.14.0.']
  ];
  const bar = document.createElement('div');
  bar.className = 'scene-choices';
  bar.setAttribute('role','group');
  bar.setAttribute('aria-label','Choose a sample request');
  lab.querySelector('.lab-layout').before(bar);
  const replay = lab.querySelector('.play-scene');
  const ask = lab.querySelector('.ask-bubble');
  const command = lab.querySelector('samp b');
  const result = lab.querySelector('.cmd-result');
  const answer = lab.querySelector('.answer-bubble');
  let active = 0, timer, advance, visible = false, paused = false;
  function schedule() {
    clearTimeout(advance);
    if (!visible || paused || document.hidden || !motionOK()) return;
    advance = setTimeout(() => show((active + 1) % scenarios.length, true), 6500);
  }
  function show(index, animate) {
    clearInterval(timer);
    active = index;
    const [, question, cmd, output, reply] = scenarios[index];
    [...bar.children].forEach((b,i) => b.setAttribute('aria-pressed',String(i === index)));
    ask.textContent = question;
    answer.querySelector('p').textContent = reply;
    let tick = animate ? 0 : 100;
    function paint() {
      command.textContent = cmd.slice(0, Math.max(0,tick - 4));
      result.textContent = tick >= 29 ? output : '';
      answer.classList.toggle('thinking', tick < 38);
      if (tick++ >= 38) clearInterval(timer);
    }
    paint();
    if (animate) timer = setInterval(paint,65);
    schedule();
  }
  const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'off';
  scenarios.forEach(([label],i) => {
    const b=document.createElement('button');
    b.type='button';
    b.textContent=label;
    b.addEventListener('click',() => show(i,motionOK()));
    bar.append(b);
  });
  function refresh() {
    const running = !paused && motionOK();
    replay.textContent = running ? 'Pause demo' : 'Replay demo';
    if (!running || !visible || document.hidden) show(active,false);
    else show(active,true);
  }
  replay.addEventListener('click',() => {
    if (motionOK()) paused = !paused;
    refresh();
  });
  show(0,false);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    refresh();
  }, {threshold:0.15});
  observer.observe(lab);
  document.addEventListener('visibilitychange',refresh);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',refresh);
  new MutationObserver(refresh).observe(document.documentElement,{attributes:true,attributeFilter:['data-motion']});
}
