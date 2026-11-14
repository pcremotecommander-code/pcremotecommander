const search = document.querySelector('#search');
const filters = [...document.querySelectorAll('[data-filter]')];
const cards = [...document.querySelectorAll('.card[data-category]')];
function update() {
  const category = filters.find(button => button.getAttribute('aria-pressed') === 'true').dataset.filter;
  const term = search.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const card of cards) {
    const searchable = [...card.querySelectorAll('small, h2, p')].map(item => item.textContent).join(' ').toLocaleLowerCase();
    const show = (category === 'all' || card.dataset.category === category) && searchable.includes(term);
    card.hidden = !show;
    if (show) visible++;
  }
  document.querySelector('#count').textContent = `${visible} of ${cards.length} prompt ideas`;
  document.querySelector('#empty').style.display = visible ? 'none' : 'block';
}
search.addEventListener('input', update);
function wireFilter(button) { button.addEventListener('click', () => {
  for (const item of filters) item.setAttribute('aria-pressed', String(item === button));
  update();
}); }
for (const button of filters) wireFilter(button);
update();

async function loadPublishedPrompts() {
  const response = await fetch('/library/prompts', {headers: {'Accept': 'application/json'}});
  if (!response.ok) throw Error('Library unavailable');
  const data = await response.json();
  if (!Array.isArray(data.prompts) || !Array.isArray(data.categories)) throw Error('Invalid library');
  const names = new Map();
  for (const category of data.categories.slice(0, 30)) {
    if (typeof category.id !== 'string' || typeof category.name !== 'string') continue;
    names.set(category.id, category.name);
    if (filters.some(button => button.dataset.filter === category.id)) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.filter = category.id;
    button.textContent = category.name; button.setAttribute('aria-pressed', 'false');
    document.querySelector('.filters').append(button); filters.push(button); wireFilter(button);
  }
  for (const item of data.prompts.slice(0, 50)) {
    if (!['title', 'description', 'prompt', 'category'].every(key => typeof item[key] === 'string') || !names.has(item.category)) continue;
    const card = document.createElement('article'); card.className = 'card'; card.dataset.category = item.category;
    for (const [tag, text] of [['small', names.get(item.category)], ['h2', item.title], ['p', item.description]]) {
      const node = document.createElement(tag); node.textContent = text; card.append(node);
    }
    const content = document.createElement('div'); content.className = 'prompt-content';
    const prompt = document.createElement('pre'); prompt.textContent = item.prompt;
    content.append(prompt); card.append(content); document.querySelector('#cards').prepend(card); cards.push(card);
  }
  document.dispatchEvent(new Event('pcrc:copy-ready'));
  update();
}
loadPublishedPrompts().catch(() => {
  const note = document.createElement('p'); note.className = 'count'; note.setAttribute('role', 'status');
  note.textContent = 'Published additions are temporarily unavailable. The starter prompts below are still available.';
  document.querySelector('#count').after(note);
});
