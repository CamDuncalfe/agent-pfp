import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const text = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');

/** The numbered rules under "## Rules" as { number, heading, body }. */
function rules(markdown) {
  const start = markdown.indexOf('\n## Rules\n');
  assert.notEqual(start, -1, 'AGENTS.md has a "Rules" section');
  const rest = markdown.slice(start + '\n## Rules\n'.length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  return section
    .split(/^### /m)
    .slice(1)
    .map((part) => {
      const [first, ...lines] = part.split('\n');
      const match = /^(\d+)\. (.+)$/.exec(first);
      assert.ok(match, `rule heading "${first}" is a number, a dot and a title`);
      return { number: Number(match[1]), heading: match[2], body: lines.join('\n').trim() };
    });
}

const all = rules(text);

test('the rules are numbered from 1 with no gap or repeat', () => {
  assert.ok(all.length > 0, 'AGENTS.md has at least one rule');
  assert.deepEqual(
    all.map((rule) => rule.number),
    all.map((_, i) => i + 1),
  );
});

test('each rule is one paragraph, then a Where line, then a Why line', () => {
  for (const rule of all) {
    const lines = rule.body.split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 3, `rule ${rule.number} has three parts`);
    assert.ok(!lines[0].startsWith('- '), `rule ${rule.number} starts with the rule itself`);
    assert.ok(lines[1].startsWith('- **Where:** '), `rule ${rule.number} has a Where line second`);
    assert.ok(lines[2].startsWith('- **Why:** '), `rule ${rule.number} has a Why line last`);
  }
});
