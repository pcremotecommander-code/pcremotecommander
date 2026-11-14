import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/', import.meta.url));

test('public guides link to real static pages and keep staging claims accurate', () => {
  const home = readFileSync(`${root}index.html`, 'utf8');
  const prompts = readFileSync(`${root}prompts/index.html`, 'utf8');
  const chatgpt = readFileSync(`${root}mcp/chatgpt/index.html`, 'utf8');
  const script = readFileSync(`${root}prompts/library.js`, 'utf8');
  assert.match(home, /href="\/prompts\/"/);
  assert.match(home, /href="\/mcp\/chatgpt\/"/);
  assert.match(prompts, /src="\/prompts\/library\.js"/);
  assert.match(prompts, /issues\/new\?template=prompt\.yml/);
  assert.match(prompts, /data-category="edit"/);
  assert.match(script, /card\.hidden = !show/);
  assert.match(chatgpt, /Custom plugins depend on ChatGPT workspace eligibility/);
  assert.match(chatgpt, /pcremotecommander\.workers\.dev\/mcp/);
});

test('homepage explains practical benefits and fair coding-agent tradeoffs with current dashboard links',()=>{
  const page=readFileSync(`${root}index.html`,'utf8');
  assert.equal((page.match(/id="benefits"/g)??[]).length,1);
  assert.match(page,/PCRC, Codex or Claude Code/);
  assert.match(page,/Build with multiple AI assistants/);
  assert.match(page,/beta\.35, up to eight active assignments/);
  assert.match(page,/Conflicting claims wait their turn/);
  assert.match(page,/does not automatically launch models/);
  assert.doesNotMatch(page,/PCRC may add little/);
  assert.match(page,/CLI is not an autonomous coding assistant/);
  assert.match(page,/href="https:\/\/pc-remote-commander\.pcremotecommander\.workers\.dev\/devices"/);
  assert.doesNotMatch(page,/href="\/devices(?:["/?])/);
  assert.match(page,/<caption>Choose by the workflow/);
});

test('setup and legal pages disclose release limits and have real navigation targets', () => {
  const home = readFileSync(`${root}index.html`, 'utf8');
  const setup = readFileSync(`${root}setup/index.html`, 'utf8');
  assert.match(setup, /public npm launcher supports Windows only/);
  assert.match(setup, /does not automatically pair Linux/);
  for (const id of ['windows', 'linux', 'chatgpt', 'claude', 'cursor', 'test', 'help']) {
    assert.ok(setup.includes(`id="${id}"`), `Missing setup target: ${id}`);
  }
  for (const route of ['setup', 'terms', 'privacy']) {
    assert.ok(home.includes(`href="/${route}/"`));
    const page = readFileSync(`${root}${route}/index.html`, 'utf8');
    assert.match(page, /href="\/info.css"/);
    if (route !== 'setup') {
      assert.match(page, /Janagiri, India/);
      assert.match(page, /href="https:\/\/pc-remote-commander\.pcremotecommander\.workers\.dev\/devices\/account"/);
      assert.match(page, /sandbox/i);
    }
  }
});

test('local guide provides valid stdio configurations without pairing credentials',()=>{
  const local=readFileSync(`${root}mcp/local/index.html`,'utf8');
  const snippets=[...local.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(match=>match[1].replaceAll('&quot;','"').replaceAll('&amp;','&'));
  const configurations=snippets.filter(value=>value.trim().startsWith('{')).map(value=>JSON.parse(value));
  assert.equal(configurations.length,2);
  for(const config of configurations) {
    const server=config.mcpServers['pcrc-local'];
    if(server.command==='node') {
      assert.match(server.args[0],/deploy\/mcp-task-server\/dist\/main\.js$/);
      assert.equal(server.env.JAN_MCP_CONTROL,'0');
      assert.equal(server.env.JAN_MCP_CAPABILITIES,undefined);
      assert.ok(server.env.JAN_MCP_PYTHON.endsWith('/python.exe'));
    } else {
      assert.equal(server.args.at(-1),'serve');
      assert.ok(server.args.includes('--workspace'));
      assert.equal(server.env.JAN_MCP_ALLOW_WRITES,'0');
    }
    assert.equal(server.url,undefined);
  }
  assert.match(readFileSync(`${root}index.html`,'utf8'),/href="\/mcp\/local\/"/);
  assert.match(local,/doctor/);
});

test('merchant-review pricing and refund pages are public static documents with accurate billing limits',()=>{
  const pricing=readFileSync(`${root}pricing/index.html`,'utf8');
  const refunds=readFileSync(`${root}refunds/index.html`,'utf8');
  assert.match(pricing,/15,000/);assert.match(pricing,/USD 15/);assert.match(pricing,/sandbox/i);
  for(const page of [pricing,refunds]) {
    assert.match(page,/Janagiri, India/);
    assert.match(page,/href="\/terms\/"/);assert.match(page,/href="\/privacy\/"/);
    assert.match(page,/janagiri3297@gmail.com/);
    assert.doesNotMatch(page,/client_secret|PADDLE_LIVE_API_KEY/);
  }
  assert.match(refunds,/14 days/);assert.match(refunds,/does not cancel/i);
});


test('static assets explicitly prevent framing and referrer leakage without disabling Paddle checkout',()=>{
  const headers=readFileSync(`${root}_headers`,'utf8');
  for(const line of ['Strict-Transport-Security: max-age=31536000','X-Content-Type-Options: nosniff','X-Frame-Options: DENY','Referrer-Policy: no-referrer',"frame-ancestors 'none'",'Permissions-Policy: camera=(), microphone=(), geolocation=()'])assert.ok(headers.includes(line),line);
  assert.ok(!headers.includes('payment=()'));
});


test('Windows install pages show npm first and the automatic bootstrap directly below',()=>{
  for(const route of ['index.html','setup/index.html']){
    const page=readFileSync(`${root}${route}`,'utf8');
    const short=page.indexOf('npx --yes pcremotecommander@beta setup');
    const fallback=page.indexOf('powershell -NoProfile -Command');
    assert.ok(short>=0&&fallback>short,route);
    assert.match(page,/If the command above does not work/);
  }
});

test('public setup links to six dedicated guides with distinct client instructions',()=>{
 const setup=readFileSync(`${root}setup/index.html`,'utf8');
 const home=readFileSync(`${root}index.html`,'utf8');
 for(const client of ['chatgpt','claude','claude-desktop','cursor','lovable','local']) {
  const route=`href="/mcp/${client}/"`;
  assert.ok(setup.includes(route),client);
  assert.ok(home.includes(route),client);
  const guide=readFileSync(`${root}mcp/${client}/index.html`,'utf8');
  assert.ok(guide.includes(`${route} aria-current="page"`),client);
  assert.match(guide,/<video[^>]+muted loop/);
 }
 const claude=readFileSync(`${root}mcp/claude/index.html`,'utf8');
 const cursor=readFileSync(`${root}mcp/cursor/index.html`,'utf8');
 assert.match(claude,/Sign in now/);
 assert.match(claude,/Add custom connector/);
 assert.match(claude,/claude-polished\.mp4/);
 assert.doesNotMatch(claude,/Add custom MCP server/);
 assert.match(cursor,/~\/\.cursor\/mcp\.json/);
 assert.match(cursor,/mcpServers/);
 assert.doesNotMatch(cursor,/Add custom connector|chatgpt\.com/);
});

test('individual public client guides contain only their own install steps',()=>{
 for(const client of ['claude','cursor']) {
  const html=readFileSync(`${root}mcp/${client}/index.html`,'utf8');
  assert.match(html,new RegExp('id="'+client+'"'));
  for(const other of ['chatgpt','claude','cursor'].filter(x=>x!==client))assert.doesNotMatch(html,new RegExp('id="'+other+'"'));
  assert.doesNotMatch(html,/Add custom MCP server/);
 }
});

test('Claude release recording exists',{skip:process.env.PCRC_SOURCE_ONLY_TESTS === '1' ? 'Source checkout excludes private demo recordings' : false},()=>{
 assert.ok(readFileSync(`${root}mcp/media/claude-polished.mp4`).length>0);
});
