import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { QODO_BOT } from '../factory/decisions.js';
import { addEntry, addResult, buildEntry, ciRunOf, detailsFor, isLogOnly, parseArgs, renderCheckLine, renderLog, renderRow, severities } from '../factory/log-entry.js';

const SHA_HEAD = 'a'.repeat(40);
const SHA_FIX = 'b'.repeat(40);
const SHA_MERGE = 'c'.repeat(40);

/** A review comment in the shape Qodo writes: one open finding under a Low badge and one resolved finding. */
function review({ open = [], resolved = [] } = {}) {
  const openPart = open
    .map(
      (title, i) => `<img src="https://img.shields.io/badge/Low-6B7280?style=flat-square" height="20px" alt="Informational">

<details>
<summary>  ${i + 1}.  ${title} <code>🐞 Bug</code></summary>
<hr/>
</details>`,
    )
    .join('\n');
  const resolvedPart = resolved.length
    ? `<details><summary><strong>Resolved findings</strong></summary>
${resolved
  .map(
    (title, i) => `<details>
<summary>  ${i + 1}.  <s>${title}</s> <code>✓ Resolved</code></summary>
<p><b>Resolving commit:</b> <a href="https://github.com/o/r/commit/${SHA_FIX}"><code>bbbbbbb</code></a></p>
<hr/>
</details>`,
  )
  .join('\n')}
</details>`
    : '';
  return `<h3>Code Review by Qodo</h3>\n\n${openPart}\n${resolvedPart}\n<!-- https://github.com/o/r/commit/${SHA_HEAD} -->`;
}

const comment = (body, login = QODO_BOT) => ({ user: { login }, body });

const PR = {
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  mergedAt: '2026-11-12T01:14:45Z',
  mergeCommit: { oid: SHA_MERGE },
  closingIssuesReferences: [{ number: 6 }],
};

test('buildEntry: the fixed findings with their severity and commit, from the review comment and qodo', () => {
  const entry = buildEntry({
    pr: PR,
    comments: [comment('<h3>PR Summary by Qodo</h3>'), comment(review({ open: ['A Low one'], resolved: ['Layer path read two ways'] }))],
    qodo: { findings: [{ title: 'Layer path read two ways', action_level: 'remediation_recommended' }] },
    renderCheck: 'fixture-shapes: all 48, 0 failed; Render check passed',
    ci: 'success',
    day: 8,
    taste: 'The wider page',
    post: 'https://example.com/post',
  });
  assert.deepEqual(entry, {
    pr: 7,
    url: PR.url,
    mergedAt: PR.mergedAt,
    merge: SHA_MERGE,
    tickets: [6],
    day: 8,
    review: 'findings',
    caught: [{ severity: 'Medium', title: 'Layer path read two ways', fixedIn: SHA_FIX }],
    renderCheck: 'fixture-shapes: all 48, 0 failed; Render check passed',
    taste: 'The wider page',
    post: 'https://example.com/post',
  });
});

test('buildEntry: a review with no findings, no review, and no render check line', () => {
  const clean = buildEntry({ pr: PR, comments: [comment(review())], qodo: null, renderCheck: null, ci: 'success' });
  assert.equal(clean.review, 'nothing');
  assert.deepEqual(clean.caught, []);
  assert.equal(clean.renderCheck, 'CI success');
  assert.equal(clean.day, null);
  assert.equal(clean.taste, null);
  const none = buildEntry({ pr: { ...PR, closingIssuesReferences: [] }, comments: [comment(review(), 'someone')], qodo: null, renderCheck: null, ci: null });
  assert.equal(none.review, 'none');
  assert.equal(none.renderCheck, 'unknown');
  assert.deepEqual(none.tickets, []);
});

test('buildEntry: a resolved finding qodo has no severity for reads unknown', () => {
  const entry = buildEntry({ pr: PR, comments: [comment(review({ resolved: ['Some fix'] }))], qodo: null, renderCheck: null, ci: 'success' });
  assert.deepEqual(entry.caught, [{ severity: 'unknown', title: 'Some fix', fixedIn: SHA_FIX }]);
});

test('severities: each action_level as the severity AGENTS.md gives it', () => {
  const map = severities({
    findings: [
      { title: 'One', action_level: 'action_required' },
      { title: ' Two  words ', action_level: 'remediation_recommended' },
      { title: 'Three', action_level: 'informational' },
      { title: 'Twice', action_level: 'informational' },
      { title: 'Twice', action_level: 'action_required' },
    ],
  });
  assert.equal(map.get('One'), 'High');
  assert.equal(map.get('Two words'), 'Medium');
  assert.equal(map.get('Three'), 'Low');
  assert.equal(map.get('Twice'), null);
  assert.equal(severities(null).size, 0);
});

test('renderCheckLine: each style and the verdict from the npm run check step of a CI log', () => {
  const log = [
    'test\tUNKNOWN STEP\t2026-11-16T12:56:53.33Z ok 166 - fixtures/shapes passes the render check',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.50Z ##[group]Run npm run check',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z > agent-pfp@0.1.0 check',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z > node bin/check-styles.js styles/index.json fixtures/index.json',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Style: alien',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Combinations checked: a sample of 2000 different ones out of 648000, 0 failed',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Render check passed.',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Style: fixture-shapes',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Combinations checked: all 48, 0 failed',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Render check passed.',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Styles checked: 2',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.51Z Render check passed.',
    'test\tUNKNOWN STEP\t2026-11-16T12:57:19.52Z Post job cleanup.',
  ].join('\n');
  assert.equal(
    renderCheckLine(log),
    'alien: a sample of 2000 different ones out of 648000, 0 failed; fixture-shapes: all 48, 0 failed; Render check passed',
  );
  assert.equal(renderCheckLine('test\tstep\t2026-11-16T12:57:19.51Z ok 1 - the render check passes'), null);
  assert.equal(renderCheckLine(''), null);
});

test('isLogOnly: a pull request that only changes the log has no row', () => {
  assert.equal(isLogOnly(['docs/factory-log.json', 'docs/factory-log.md']), true);
  assert.equal(isLogOnly(['docs/factory-log.md']), true);
  assert.equal(isLogOnly(['docs/factory-log.md', 'factory/log.js']), false);
  assert.equal(isLogOnly([]), false);
});

test('addEntry: one entry for each pull request, oldest merge first', () => {
  const at = (pr, mergedAt) => ({ pr, mergedAt });
  const entries = addEntry([at(14, '2026-11-11T21:58:47Z'), at(17, '2026-11-11T21:54:01Z')], at(14, '2026-11-11T21:58:47Z'));
  assert.deepEqual(entries.map((e) => e.pr), [17, 14]);
  assert.deepEqual(addEntry(entries, at(9, '2026-11-11T19:47:33Z')).map((e) => e.pr), [9, 17, 14]);
});

test('parseArgs: the command, the pull request and its flags', () => {
  assert.deepEqual(parseArgs(['add', '21', '--day', '7', '--taste', 'A call', '--post', 'https://x']), {
    command: 'add',
    pr: 21,
    day: 7,
    taste: 'A call',
    post: 'https://x',
  });
  assert.equal(parseArgs(['render']).command, 'render');
  assert.throws(() => parseArgs(['add', '1', '--day']), /needs a value/);
  assert.throws(() => parseArgs(['add', '1', '--day', 'x']), /day number/);
  assert.throws(() => parseArgs(['add', '1', '--color', 'red']), /Unknown option/);
});

test('renderRow: links, findings one to a line, and an escaped pipe', () => {
  const entry = {
    pr: 7,
    url: PR.url,
    mergedAt: PR.mergedAt,
    merge: SHA_MERGE,
    tickets: [6],
    day: null,
    review: 'findings',
    caught: [
      { severity: 'High', title: 'A | B', fixedIn: SHA_FIX },
      { severity: 'Low', title: 'C', fixedIn: SHA_FIX },
    ],
    renderCheck: 'CI success',
    taste: null,
    post: null,
  };
  assert.equal(
    renderRow(entry),
    `| 2026-11-12 | | [#6](https://github.com/o/r/issues/6) | [#7](${PR.url}) [\`ccccccc\`](https://github.com/o/r/commit/${SHA_MERGE}) | High: A \\| B<br>Low: C | [\`bbbbbbb\`](https://github.com/o/r/commit/${SHA_FIX}) | CI success | No | |`,
  );
  assert.match(renderRow({ ...entry, review: 'nothing', caught: [] }), /\| Nothing \| \|/);
});

test('docs/factory-log.md is written from docs/factory-log.json', async () => {
  const entries = JSON.parse(await readFile(new URL('../docs/factory-log.json', import.meta.url), 'utf8'));
  const markdown = await readFile(new URL('../docs/factory-log.md', import.meta.url), 'utf8');
  assert.equal(markdown, renderLog(entries), 'run `node factory/log.js render` after changing the JSON');
  assert.deepEqual(
    entries.map((e) => e.mergedAt),
    entries.map((e) => e.mergedAt).sort(),
    'the entries are in merge order',
  );
  assert.equal(new Set(entries.map((e) => e.pr)).size, entries.length, 'one entry for each pull request');
});

test('ciRunOf: the newest finished CI run the pull request shows, never another workflow', () => {
  const check = (id, completedAt, extra = {}) => ({
    __typename: 'CheckRun',
    workflowName: 'CI',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    completedAt,
    detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
    ...extra,
  });
  assert.deepEqual(ciRunOf([check(1, '2026-11-16T16:33:20Z'), check(2, '2026-11-16T16:40:00Z', { conclusion: 'FAILURE' })]), {
    id: '2',
    conclusion: 'failure',
  });
  assert.equal(ciRunOf([check(3, '2026-11-16T16:33:20Z', { workflowName: 'Pages' })]), null);
  assert.equal(ciRunOf([check(4, null, { status: 'IN_PROGRESS', conclusion: '' })]), null);
  assert.equal(ciRunOf([check(5, '2026-11-16T16:33:20Z', { detailsUrl: 'https://example.com' })]), null);
  assert.equal(ciRunOf(undefined), null);
});

test('detailsFor: adding a row again keeps the day, taste call and post that its flags leave out', () => {
  const entries = [{ pr: 21, day: 7, taste: 'Scaling the picture', post: 'https://x/post' }];
  const none = { pr: 21, day: null, taste: null, post: null };
  assert.deepEqual(detailsFor(entries, none), { day: 7, taste: 'Scaling the picture', post: 'https://x/post' });
  assert.deepEqual(detailsFor(entries, { ...none, day: 8 }), { day: 8, taste: 'Scaling the picture', post: 'https://x/post' });
  assert.deepEqual(detailsFor(entries, { ...none, pr: 22 }), { day: null, taste: null, post: null });
  assert.deepEqual(detailsFor([], parseArgs(['add', '9', '--taste', 'A call'])), { day: null, taste: 'A call', post: null });
});

test('addResult: a pull request that is not merged ends with 2 and writes nothing', () => {
  const result = addResult({ entries: [], pr: { ...PR, mergedAt: null, files: [{ path: 'src/a.js' }] }, options: parseArgs(['add', '7']) });
  assert.deepEqual(result, { code: 2, message: '#7 is not merged.', entries: null });
});

test('addResult: a pull request that only changes the log gets no entry', () => {
  const pr = { ...PR, files: [{ path: 'docs/factory-log.json' }, { path: 'docs/factory-log.md' }] };
  assert.deepEqual(addResult({ entries: [], pr, options: parseArgs(['add', '7']) }), {
    code: 0,
    message: '#7 only changes the log, so it gets no entry.',
    entries: null,
  });
});

test('addResult: a merged pull request replaces its older entry and keeps the details its flags leave out', () => {
  const old = { pr: 7, mergedAt: PR.mergedAt, day: 8, taste: 'The wider page', post: 'https://x/post' };
  const other = { pr: 5, mergedAt: '2026-11-11T18:46:10Z' };
  const result = addResult({
    entries: [old, other],
    pr: { ...PR, files: [{ path: 'src/a.js' }] },
    options: parseArgs(['add', '7']),
    comments: [comment(review({ resolved: ['Layer path read two ways'] }))],
    qodo: { findings: [{ title: 'Layer path read two ways', action_level: 'action_required' }] },
    ci: { renderCheck: 'Render check passed', ci: 'success' },
  });
  assert.equal(result.code, 0);
  assert.equal(result.message, '#7: 1 findings fixed, render check "Render check passed".');
  assert.deepEqual(result.entries.map((e) => e.pr), [5, 7]);
  const entry = result.entries[1];
  assert.deepEqual([entry.day, entry.taste, entry.post], [8, 'The wider page', 'https://x/post']);
  assert.deepEqual(entry.caught, [{ severity: 'High', title: 'Layer path read two ways', fixedIn: SHA_FIX }]);
});

test('renderRow: a fix from a later pull request names that pull request', () => {
  const entry = {
    pr: 7,
    url: PR.url,
    mergedAt: PR.mergedAt,
    merge: SHA_MERGE,
    tickets: [],
    day: null,
    review: 'findings',
    caught: [{ severity: 'Medium', title: 'C', fixedIn: SHA_FIX, fixedInPr: 9 }],
    renderCheck: 'CI success',
    taste: null,
    post: null,
  };
  assert.match(renderRow(entry), new RegExp(`\\| \\[\`bbbbbbb\`\\]\\(https://github.com/o/r/commit/${SHA_FIX}\\) in \\[#9\\]\\(https://github.com/o/r/pull/9\\) \\|`));
  assert.doesNotMatch(renderLog([entry]), /blank/i);
});

test('addResult: adding a row again keeps a finding a later pull request fixed', () => {
  const later = { severity: 'Medium', title: 'Old size choices', fixedIn: SHA_FIX, fixedInPr: 9 };
  const old = { pr: 7, mergedAt: PR.mergedAt, day: 8, taste: null, post: null, caught: [later] };
  const result = addResult({
    entries: [old],
    pr: { ...PR, files: [{ path: 'src/a.js' }] },
    options: parseArgs(['add', '7']),
    comments: [comment(review({ resolved: ['Layer path read two ways'] }))],
    qodo: { findings: [{ title: 'Layer path read two ways', action_level: 'action_required' }] },
    ci: { renderCheck: 'Render check passed', ci: 'success' },
  });
  assert.deepEqual(result.entries[0].caught, [{ severity: 'High', title: 'Layer path read two ways', fixedIn: SHA_FIX }, later]);
});
