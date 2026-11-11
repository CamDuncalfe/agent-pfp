import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';

import { resolveRequestPath } from '../bin/serve.js';

const root = `${sep}srv${sep}app`;

test('request paths map to files inside the root', () => {
  assert.equal(resolveRequestPath(root, '/web/index.html'), join(root, 'web', 'index.html'));
  assert.equal(resolveRequestPath(root, '/web/?manifest=x'), join(root, 'web'));
  assert.equal(resolveRequestPath(root, '/'), root);
});

test('paths that try to leave the root or reach hidden files are refused', () => {
  for (const url of ['/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/web/..%2f..%2fetc', '/.git/config', '/node_modules/x/index.js', '/%00', '/%E0%A4%A']) {
    const target = resolveRequestPath(root, url);
    assert.ok(target === null || target === root || target.startsWith(root + sep), url);
    if (url.includes('.git') || url.includes('node_modules') || url.includes('%00') || url.includes('%E0')) {
      assert.equal(target, null, url);
    }
  }
});
