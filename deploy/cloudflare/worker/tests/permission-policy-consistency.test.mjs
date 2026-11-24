import test from 'node:test';
import assert from 'node:assert/strict';
import { actionAccess, requiresActionReview } from '../src/action_access.ts';
import { CONTROL_CATALOG_READ_TOOLS } from '../src/relay_protocol.ts';

test('every gateway read-only tool uses the same read approval route', () => {
  const readOnlyTools = [
    'read_multiple_files',
    'list_workspace_entries',
    'search_workspace',
    'read_file_excerpt',
    'list_browser_tabs',
    'inspect_browser_page',
    'capture_browser',
    'inspect_desktop_controls',
  ];

  for (const name of readOnlyTools) {
    assert.equal(actionAccess(name), 'read', name);
    assert.equal(CONTROL_CATALOG_READ_TOOLS.has(name), true,
      name + ' must not be routed through write approval');
  }
});

test('unknown tools remain writes and retain high-risk warning behavior', () => {
  for (const name of ['unknown_new_tool', 'future_mutation']) {
    assert.equal(actionAccess(name), 'write', name);
    assert.equal(requiresActionReview(name), true, name);
  }
});

test('approval routing, access type and dashboard warning severity stay independent', () => {
  assert.equal(actionAccess('inspect_desktop_controls'), 'read');
  assert.equal(CONTROL_CATALOG_READ_TOOLS.has('inspect_desktop_controls'), true);
  assert.equal(requiresActionReview('inspect_desktop_controls'), false);

  assert.equal(actionAccess('create_text_file'), 'write');
  assert.equal(CONTROL_CATALOG_READ_TOOLS.has('create_text_file'), false);
  assert.equal(requiresActionReview('create_text_file'), false);

  assert.equal(actionAccess('run_command'), 'write');
  assert.equal(CONTROL_CATALOG_READ_TOOLS.has('run_command'), false);
  assert.equal(requiresActionReview('run_command'), true);
});
