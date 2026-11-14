function enhanceCopy() {
for (const content of document.querySelectorAll('pre, code.command, code.endpoint')) {
  if (content.parentElement?.classList.contains('copy-block')) continue;
  const block = document.createElement('div');
  block.className = 'copy-block' + (content.tagName === 'CODE' ? ' command-block' : '');
  content.before(block);
  block.append(content);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  const prompt = Boolean(content.closest('.card[data-category]'));
  const label = prompt ? 'Copy prompt' : 'Copy code';
  button.setAttribute('aria-label', label);
  button.title = label;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const [x, y] of [[8, 8], [4, 4]]) {
    const rect = document.createElementNS(icon.namespaceURI, 'rect');
    for (const [key, value] of Object.entries({x, y, width: 12, height: 12, rx: 2})) rect.setAttribute(key, value);
    icon.append(rect);
  }
  const feedback = document.createElement('span');
  feedback.className = 'copy-feedback';
  feedback.setAttribute('role', 'status');
  const card = prompt ? content.closest('.card[data-category]') : null;
  if (card) card.append(button, feedback);
  else block.append(button, feedback);
  button.append(icon);
  let timer;
  button.addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(content.textContent.trim());
      feedback.textContent = 'Copied';
    } catch {
      feedback.textContent = 'Select the text and copy it manually.';
    }
    timer = setTimeout(() => { feedback.textContent = ''; }, 2500);
  });
}
}
enhanceCopy();
document.addEventListener('pcrc:copy-ready', enhanceCopy);
