window.addEventListener('load', () => {
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid']) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
}, { once: true });
