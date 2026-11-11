import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { GUARDED_FOLDERS } from '../factory/decisions.js';

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

/** The parts of a rule: the text, the "Where" line and the "Why" line. */
function parts(rule) {
  const lines = rule.body.split('\n').filter((line) => line.trim() !== '');
  const where = lines.filter((line) => line.startsWith('- **Where:** '));
  const why = lines.filter((line) => line.startsWith('- **Why:** '));
  const prose = lines.filter((line) => !line.startsWith('- '));
  return { lines, where, why, prose };
}

const all = rules(text);
const six = all.find((rule) => rule.number === 6);

test('the rules are numbered 1 to 6 with no gap or repeat', () => {
  assert.deepEqual(
    all.map((rule) => rule.number),
    [1, 2, 3, 4, 5, 6],
  );
});

test('each rule, rule 6 included, is a short heading, the rule, a Where line and a Why line', () => {
  for (const rule of all) {
    const { lines, where, why, prose } = parts(rule);
    assert.ok(rule.heading.split(' ').length <= 6, `rule ${rule.number} has a short heading`);
    assert.equal(prose.length, 1, `rule ${rule.number} is one paragraph`);
    assert.equal(where.length, 1, `rule ${rule.number} has one Where line`);
    assert.equal(why.length, 1, `rule ${rule.number} has one Why line`);
    assert.deepEqual(lines, [prose[0], where[0], why[0]], `rule ${rule.number} is in the order rule, Where, Why`);
  }
  assert.equal(six.heading, 'Keep the docs true');
});

test('rule 6 says a pull request corrects each sentence its change makes untrue', () => {
  const [prose] = parts(six).prose;
  assert.ok(
    prose.includes(
      'A pull request corrects each sentence in AGENTS.md, README.md, `docs/` or a code comment that its change makes untrue.',
    ),
  );
});

test('rule 6 says a pull request leaves a numbered rule alone and names it in its description', () => {
  const [prose] = parts(six).prose;
  assert.match(prose, /numbered rules are the exception/);
  assert.match(prose, /leaves the rule's text alone/);
  assert.match(prose, /says in its description which rule and why, so I can decide/);
});

test('rule 6 agrees with the line that keeps a factory run out of the guarded folders', () => {
  const guard = text.split('\n').filter((line) => line.includes('alone in such a run'));
  assert.equal(guard.length, 1, 'one line tells a factory run which folders to leave alone');
  const sentence = parts(six)
    .prose[0].split(/(?<=\.) /)
    .filter((item) => item.includes('factory runner'));
  assert.equal(sentence.length, 1, 'one sentence of rule 6 is about a factory run');
  for (const folder of GUARDED_FOLDERS) {
    assert.ok(guard[0].includes(`\`${folder}\``), `the guard line names ${folder}`);
    assert.ok(sentence[0].includes(`\`${folder}\``), `rule 6 names ${folder}`);
  }
  assert.match(sentence[0], /leaves the sentence alone and names it in its description/);
});

test('the Why line of rule 6 links the two Qodo reviews', () => {
  const [why] = parts(six).why;
  assert.ok(why.includes('(https://github.com/CamDuncalfe/agent-pfp/pull/5#issuecomment-6804310388)'));
  assert.ok(why.includes('(https://github.com/CamDuncalfe/agent-pfp/pull/1#issuecomment-6799376654)'));
});

test('no line outside rule 6 talks about untrue sentences or about who changes the rules', () => {
  const start = text.indexOf('### 6. ');
  const before = text.slice(0, start);
  assert.equal(text.slice(start).split(/^##+ /m).length, 2, 'rule 6 is the last section');
  assert.doesNotMatch(before, /untrue|no longer true|out of date|stale/i);
  assert.doesNotMatch(before, /(change|edit|rewrite)[^.\n]*\b(a|the|these) (numbered )?rules?\b/i);
});
