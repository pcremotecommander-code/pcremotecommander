const menu = document.querySelector('.mcp-menu');
if (menu) {
  const toggle = menu.querySelector('summary');
  menu.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse' && matchMedia('(hover: hover)').matches) menu.open = true;
  });
  menu.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !menu.contains(document.activeElement)) menu.open = false;
  });
  menu.addEventListener('focusout', (event) => {
    if (!menu.contains(event.relatedTarget) && !menu.matches(':hover')) menu.open = false;
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      toggle.focus();
      event.preventDefault();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
}
