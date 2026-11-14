import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/copy.js', import.meta.url), 'utf8');

test('copy controls preserve command and prompt text and report clipboard rejection', async () => {
  for (const text of ['npx --yes pcremotecommander@beta setup', 'First line\n  preserve indentation']) {
    for (const denied of [false, true]) for (const isPrompt of [false,true]) {
      const made = [];
      let copied;
      const element = () => ({
        setAttribute() {}, append() {},
        addEventListener(_type, handler) { this.click = handler; },
      });
      const cardChildren=[];
      const card={append(...items){cardChildren.push(...items);}};
      const content = { textContent: text, before() {}, closest: () => isPrompt?card:null };
      const create = () => { const item = element(); made.push(item); return item; };
      vm.runInNewContext(source, {
        document: { addEventListener() {}, querySelectorAll: () => [content], createElement: create, createElementNS: create },
        navigator: { clipboard: { writeText: async value => {
          if (denied) throw Error('denied');
          copied = value;
        } } },
        clearTimeout() {}, setTimeout() {},
      });
      await made.find(item => item.className === 'copy-button').click();
      const feedback = made.find(item => item.className === 'copy-feedback');
      assert.equal(cardChildren.includes(feedback),isPrompt);
      assert.equal(feedback.textContent, denied ? 'Select the text and copy it manually.' : 'Copied');
      assert.equal(copied, denied ? undefined : text);
    }
  }
});
