import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

import {
  AGENT_BUILTIN_TOOLS,
  AGENT_DENIED,
  AGENT_TOOLS,
  GUARDED_FOLDERS,
  LABELS,
  LIMITS,
  QODO_BOT,
  acceptanceCriteria,
  agentArgs,
  blocks,
  branchFor,
  candidates,
  carryRunError,
  ciState,
  criteriaList,
  fillPrompt,
  findingsText,
  guardedFiles,
  labelledBy,
  lockCommand,
  lowFindingsText,
  fixRoundText,
  readyComment,
  nextStep,
  parseQodoReview,
  prBody,
  promptPlaces,
  promptValues,
  qodoCall,
  qodoRunArgs,
  reviewFor,
  reviewPoll,
  reviewOf,
  reviewRunState,
  ticketProblems,
} from '../factory/decisions.js';

const OWNER = 'owner';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function issue(number, labels, extra = {}) {
  return {
    number,
    state: 'open',
    title: `Ticket ${number}`,
    user: { login: OWNER },
    labels: labels.map((name) => ({ name })),
    ...extra,
  };
}

/** A review comment in the shape Qodo posts: numbered findings, then the commit it looked at. */
function reviewBody({ commit = SHA_A, open = [], resolved = [] } = {}) {
  const finding = (title, n, done) => `<details>
<summary>  ${n}.  ${done ? `<s>${title}</s> <code>✓ Resolved</code>` : `${title} <code>🐞 Bug</code>`}</summary>

<br/>

> <details>
><summary>Description</summary>
><br/>
>
><pre>
><b><i>pickStyle</i></b> reads the wrong key when the id has a &quot;quote&quot; in it,
>so a &lt;select&gt; shows nothing.
></pre>
></details>

> <details>
><summary>Agent prompt</summary>
><br/>
>
>\`\`\`
>## Issue description
>Fix ${title}.
>
>## Fix Focus Areas
>- src/styles.js[10-20]
>\`\`\`
> <code>ⓘ Copy this prompt</code>
></details>

<hr/>
</details>
`;
  const all = [...resolved.map((title) => [title, true]), ...open.map((title) => [title, false])];
  return `<h3>Code Review by Qodo</h3>

<code>🐞 Bugs (${open.length})</code>

<details><summary><ins><strong>View medium (2)</strong></ins></summary><br/>
${all.map(([title, done], i) => finding(title, i + 1, done)).join('\n')}
</details>

<details>
<summary><strong>Tip of the day</strong></summary>
</details>

${commit ? `<!-- https://github.com/owner/repo/commit/${commit} -->` : ''}
`;
}

const qodo = (body) => ({ body, user: { login: QODO_BOT, type: 'Bot' } });

test('candidates: takes labelled tickets the owner opened, lowest number first', () => {
  const { tickets, skipped } = candidates(
    [issue(9, [LABELS.ready]), issue(4, [LABELS.ready, 'enhancement']), issue(2, ['enhancement'])],
    OWNER,
  );
  assert.deepEqual(tickets.map((ticket) => ticket.number), [4, 9]);
  assert.deepEqual(skipped, []);
});

test('candidates: leaves a ticket alone when someone else opened it, it is closed or a run has it', () => {
  const { tickets, skipped } = candidates(
    [
      issue(1, [LABELS.ready], { user: { login: 'visitor' } }),
      issue(2, [LABELS.ready], { state: 'closed' }),
      issue(3, [LABELS.ready, LABELS.working]),
      issue(4, [LABELS.ready], { user: undefined }),
      issue(5, [LABELS.ready], { pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/5' } }),
    ],
    OWNER,
  );
  assert.deepEqual(tickets, []);
  assert.deepEqual(skipped.map((entry) => entry.number), [1, 2, 3, 4, 5]);
  assert.match(skipped[0].reason, /visitor opened it, not owner/);
  assert.match(skipped[1].reason, /closed/);
  assert.match(skipped[2].reason, /agent-working/);
  assert.match(skipped[3].reason, /someone else opened it/);
  assert.match(skipped[4].reason, /pull request/);
});

test('candidates: the lowest number wins from a list longer than one page, in any order', () => {
  const issues = [];
  for (let number = 250; number >= 1; number -= 1) issues.push(issue(number, [LABELS.ready]));
  assert.equal(candidates(issues, OWNER).tickets[0].number, 1);
  assert.equal(candidates(issues, OWNER).tickets.length, 250);
});

test('candidates: no labelled ticket gives two empty lists', () => {
  assert.deepEqual(candidates([issue(1, []), issue(2, ['bug'])], OWNER), { tickets: [], skipped: [] });
  assert.deepEqual(candidates([], OWNER), { tickets: [], skipped: [] });
});

test('labelledBy: the person who added the label last', () => {
  const labeled = (login, name = LABELS.ready) => ({ event: 'labeled', label: { name }, actor: { login } });
  const unlabeled = (login, name = LABELS.ready) => ({ event: 'unlabeled', label: { name }, actor: { login } });
  assert.equal(labelledBy([labeled(OWNER)], LABELS.ready), OWNER);
  assert.equal(labelledBy([labeled(OWNER), unlabeled(OWNER), labeled('visitor')], LABELS.ready), 'visitor');
  assert.equal(labelledBy([labeled(OWNER), unlabeled(OWNER)], LABELS.ready), null);
  assert.equal(labelledBy([labeled(OWNER, 'bug'), { event: 'closed', actor: { login: OWNER } }], LABELS.ready), null);
  assert.equal(labelledBy([], LABELS.ready), null);
});

test('acceptanceCriteria: the numbered lines under that heading, and only those', () => {
  const body = [
    '## What I want',
    '1. This list is not the criteria.',
    '## Acceptance criteria',
    '',
    '1. The lock stays on after Randomize.',
    '2) `npm test` passes.',
    '- a bullet is not a criterion',
    '### Edge and failure cases',
    '1. Not a criterion either.',
  ].join('\n');
  assert.deepEqual(acceptanceCriteria(body), ['The lock stays on after Randomize.', '`npm test` passes.']);
  assert.deepEqual(acceptanceCriteria('## acceptance criteria\r\n1. One\r\n'), ['One']);
  assert.deepEqual(acceptanceCriteria('Acceptance criteria\n1. No heading, no criteria'), []);
  assert.deepEqual(acceptanceCriteria(undefined), []);
});

test('acceptanceCriteria: a collapsed block is left out, with its heading and its numbered lines', () => {
  // The shape of ticket #18: the criteria that count, then the first wording kept in a collapsed block.
  const body = [
    '## Acceptance criteria',
    '',
    '1. A Size picker next to Download lists Full size first.',
    '2. `npm test` passes.',
    '',
    '## Why this ticket changed',
    '',
    'The first version drew the picture again at the picked size.',
    '',
    '<details>',
    '<summary>Original wording</summary>',
    '',
    '## Acceptance criteria',
    '',
    '1. A Size picker offers GitHub, Slack and Full size.',
    '2. The file name ends with the size.',
    '',
    '</details>',
  ].join('\n');
  assert.deepEqual(acceptanceCriteria(body), ['A Size picker next to Download lists Full size first.', '`npm test` passes.']);
});

test('acceptanceCriteria: the list carries on after a collapsed block, and a block inside a block stays closed', () => {
  const body = [
    '## Acceptance criteria',
    '1. One',
    '<details><summary>Old</summary>',
    '2. Dropped',
    '<details>',
    '3. Dropped too',
    '</details>',
    '4. Still dropped',
    '</details>',
    '2. Two',
    '<details><summary>On one line</summary> 9. Dropped </details>',
    '3. Three',
  ].join('\n');
  assert.deepEqual(acceptanceCriteria(body), ['One', 'Two', 'Three']);
});

test('acceptanceCriteria: the tag named in a sentence, in inline code or in a code block opens nothing', () => {
  const criteria = ['## Acceptance criteria', '', '1. It locks.', '2. `npm test` passes.'];
  const kept = ['It locks.', '`npm test` passes.'];
  const sentence = ['Keep the old wording in a `<details>` block.', 'A <details> tag in the middle of a line opens nothing either.', '', ...criteria];
  assert.deepEqual(acceptanceCriteria(sentence.join('\n')), kept);
  assert.deepEqual(ticketProblems({ title: 'Lock a trait', body: sentence.join('\n') }), []);
  for (const marks of ['```', '~~~', '````']) {
    const fenced = [`${marks}html`, '<details>', '<summary>Old</summary>', marks, '', ...criteria];
    assert.deepEqual(acceptanceCriteria(fenced.join('\n')), kept, marks);
  }
  // Three backticks around code on one line are inline code and start no code block.
  assert.deepEqual(acceptanceCriteria(['```<details>``` is the tag.', '', ...criteria].join('\n')), kept);
});

test('acceptanceCriteria: a criterion that names the tag is kept, and so are the ones after it', () => {
  const body = [
    '## Acceptance criteria',
    '',
    '1. A `<details>` block adds no criteria.',
    '2. Text between `<details>` and `</details>` is left out.',
    '3. A line that says <details> without backticks counts too.',
    '4. `npm test` passes.',
  ].join('\n');
  assert.deepEqual(acceptanceCriteria(body), [
    'A `<details>` block adds no criteria.',
    'Text between `<details>` and `</details>` is left out.',
    'A line that says <details> without backticks counts too.',
    '`npm test` passes.',
  ]);
});

test('acceptanceCriteria: inside a collapsed block, the tag in code neither opens nor closes it', () => {
  const body = [
    '## Acceptance criteria',
    '1. One',
    '<details>',
    '<summary>Original wording</summary>',
    '',
    'Put the old list in a `<details>` block and end it with `</details>`.',
    '',
    '```html',
    '</details>',
    '```',
    '',
    '2. Dropped',
    '</details>',
    '2. Two',
    '   <details open>',
    '3. Dropped too',
    '   </details>',
    '3. Three',
  ].join('\n');
  assert.deepEqual(acceptanceCriteria(body), ['One', 'Two', 'Three']);
});

test('acceptanceCriteria: a tag inside an HTML comment neither opens nor closes a block', () => {
  const opening = ['## Acceptance criteria', '1. One', '<details>', '<!-- <details> -->', '2. Dropped', '</details>', '2. Two'];
  assert.deepEqual(acceptanceCriteria(opening.join('\n')), ['One', 'Two']);
  const closing = ['## Acceptance criteria', '1. One', '<details>', '<!-- </details> -->', '2. Dropped', '</details>', '2. Two'];
  assert.deepEqual(acceptanceCriteria(closing.join('\n')), ['One', 'Two']);
  // A comment at the start of a line hides the tag after it from nobody: the block still opens.
  const after = ['## Acceptance criteria', '1. One', '<!-- old --> <details>', '2. Dropped', '</details>', '2. Two'];
  assert.deepEqual(acceptanceCriteria(after.join('\n')), ['One', 'Two']);
  // A comment written in inline code is text, and the line is read as before.
  assert.deepEqual(acceptanceCriteria('## Acceptance criteria\n1. `<!--` starts a comment.\n<details>\n2. Dropped\n</details>\n2. Two'), [
    '`<!--` starts a comment.',
    'Two',
  ]);
});

test('acceptanceCriteria: a comment over several lines is not read for tags', () => {
  const above = ['<!--', '<details>', 'Left over from a template.', '-->', '', '## Acceptance criteria', '', '1. It locks.', '2. `npm test` passes.'];
  assert.deepEqual(acceptanceCriteria(above.join('\n')), ['It locks.', '`npm test` passes.']);
  const inside = [
    '## Acceptance criteria',
    '1. One',
    '<details>',
    '<!-- The first wording:',
    '</details>',
    '<details>',
    '```',
    'ends here --> 2. Dropped',
    '</details>',
    '2. Two',
  ];
  assert.deepEqual(acceptanceCriteria(inside.join('\n')), ['One', 'Two']);
  // As before this change, a numbered line inside a comment counts as a criterion.
  assert.deepEqual(acceptanceCriteria('## Acceptance criteria\n1. One\n<!--\n2. In a comment\n-->\n3. Three'), ['One', 'In a comment', 'Three']);
});

test('ticketProblems: criteria that come after a collapsed block with a commented tag start the agent', () => {
  const body = '<details>\n<!-- <details> -->\n\n## Acceptance criteria\n\n1. Old.\n\n</details>\n\n## Acceptance criteria\n\n1. It locks.';
  assert.deepEqual(acceptanceCriteria(body), ['It locks.']);
  assert.deepEqual(ticketProblems({ title: 'Lock a trait', body }), []);
});

test('ticketProblems: criteria that are only in a collapsed block do not start the agent', () => {
  const body = '<details>\n\n## Acceptance criteria\n\n1. It locks.\n\n</details>';
  assert.match(ticketProblems({ title: 'Lock a trait', body })[0], /Acceptance criteria/);
});

test('ticketProblems: a ticket needs a title and numbered acceptance criteria', () => {
  assert.deepEqual(ticketProblems({ title: 'Lock a trait', body: '## Acceptance criteria\n1. It locks.' }), []);
  assert.match(ticketProblems({ title: 'Lock a trait', body: 'Please lock it.' })[0], /Acceptance criteria/);
  assert.equal(ticketProblems({ title: '  ', body: null }).length, 2);
});

test('branchFor: the ticket number and a short form of the title', () => {
  assert.equal(branchFor({ number: 8, title: 'Lock a trait so Randomize leaves it alone' }), '8-lock-a-trait-so-randomize-leaves-it');
  assert.equal(branchFor({ number: 12, title: 'Download: PNG sizes for GitHub & Slack (512, 1024)' }), '12-download-png-sizes-for-github-slack-512');
  assert.equal(branchFor({ number: 3, title: '../../etc; rm -rf ~' }), '3-etc-rm-rf');
  assert.equal(branchFor({ number: 5, title: '???' }), '5-ticket');
  assert.equal(branchFor({ number: 6, title: 'a'.repeat(60) }), '6-ticket');
  assert.equal(branchFor({ number: 7, title: 'Ünïcödé title' }), '7-unicode-title');
  for (const title of ['x y z', '--flag', 'Tab\there']) {
    assert.match(branchFor({ number: 1, title }), /^1-[a-z0-9]+(-[a-z0-9]+)*$/);
  }
});

test('guardedFiles: the runner and the CI workflow are off limits to the agent', () => {
  assert.deepEqual(GUARDED_FOLDERS, ['factory/', '.github/']);
  assert.deepEqual(
    guardedFiles(['src/lock.js', 'factory/tick.js', '.github/workflows/ci.yml', 'test/factory.test.js', 'docs/factory.md']),
    ['factory/tick.js', '.github/workflows/ci.yml'],
  );
  assert.deepEqual(guardedFiles([]), []);
});

test('AGENT_TOOLS: the agent can read tickets and commit, and can not push, merge or write to GitHub', () => {
  for (const tool of AGENT_TOOLS) {
    assert.doesNotMatch(tool, /push|merge|rebase|reset|checkout|remote|worktree|rm |curl|ssh/);
    assert.doesNotMatch(tool, /^Bash\((git|gh|node|npm|npx|sh|bash)?(:\*)?\)$/, `${tool} allows any command`);
    assert.doesNotMatch(tool, /^Bash$/);
    const gh = /^Bash\(gh (.*?)(:\*)?\)$/.exec(tool);
    if (gh) assert.match(gh[1], /^(issue (view|list)|pr view)$/, `${tool} is a gh command that writes`);
  }
  assert.ok(AGENT_TOOLS.includes('Bash(gh issue view:*)'));
  assert.ok(AGENT_TOOLS.includes('Bash(git commit:*)'));
});

test('AGENT_DENIED: the file tools are refused in each guarded folder', () => {
  assert.deepEqual(AGENT_DENIED, ['Edit(factory/**)', 'Write(factory/**)', 'Edit(.github/**)', 'Write(.github/**)']);
});

test('agentArgs: the call loads no settings, no MCP server and has nobody to ask', () => {
  const args = agentArgs();
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(after('--output-format'), 'json');
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--permission-prompts'), 'none');
  assert.equal(after('--tools'), AGENT_BUILTIN_TOOLS.join(','));
  assert.ok(args.includes('--strict-mcp-config'));
  for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--add-dir', '--settings', '--mcp-config']) {
    assert.ok(!args.includes(flag), `${flag} would widen what the agent can do`);
  }
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, [...AGENT_TOOLS]);
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1), [...AGENT_DENIED]);
  assert.deepEqual(AGENT_BUILTIN_TOOLS, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
});

test('agentArgs: a model and an earlier session go after the tool lists', () => {
  const args = agentArgs({ model: 'some-model', session: 'abc-123' });
  assert.deepEqual(args.slice(-4), ['--model', 'some-model', '--resume', 'abc-123']);
  assert.deepEqual(args.slice(0, -4), agentArgs());
  assert.deepEqual(agentArgs({ model: '', session: undefined }), agentArgs());
});

test('lockCommand: the operating system holds the lock, and a held lock has its own exit code', () => {
  assert.deepEqual(lockCommand('darwin', '/tmp/f/tick.lock'), {
    command: 'lockf',
    args: ['-k', '-s', '-t', '0', '/tmp/f/tick.lock'],
    heldExit: 75,
  });
  assert.equal(lockCommand('freebsd', 'x').command, 'lockf');
  const linux = lockCommand('linux', '/tmp/f/tick.lock');
  assert.equal(linux.command, 'flock');
  assert.deepEqual(linux.args, ['--nonblock', '--conflict-exit-code', '75', '/tmp/f/tick.lock']);
  assert.equal(linux.heldExit, 75);
});

test('prBody: the ticket, its criteria word for word, then the agent\'s description', () => {
  const body = prBody(8, ['Each group has a lock.', '`npm test` passes.'], '\n## What it does\n\nIt adds locks.\n\n');
  assert.equal(
    body,
    'Closes #8\n\n## Acceptance criteria from the ticket\n\n1. Each group has a lock.\n2. `npm test` passes.\n\n## What it does\n\nIt adds locks.\n',
  );
  assert.match(prBody(8, ['One'], ''), /^Closes #8\n\n## Acceptance criteria from the ticket\n\n1\. One\n/);
});

test('parseQodoReview: reads the commit and each finding', () => {
  const review = parseQodoReview(reviewBody({ open: ['Wide pictures look square'], resolved: ['Old path check'] }));
  assert.equal(review.commit, SHA_A);
  assert.equal(review.findings.length, 2);
  const [done, open] = review.findings;
  assert.deepEqual([done.number, done.title, done.resolved], [1, 'Old path check', true]);
  assert.deepEqual([open.number, open.title, open.kind, open.resolved], [2, 'Wide pictures look square', '🐞 Bug', false]);
  assert.equal(open.description, 'pickStyle reads the wrong key when the id has a "quote" in it, so a <select> shows nothing.');
  assert.match(open.prompt, /^## Issue description\nFix Wide pictures look square\.\n\n## Fix Focus Areas\n- src\/styles\.js\[10-20\]$/);
});

test('parseQodoReview: other comments are not reviews', () => {
  assert.equal(parseQodoReview('<h3>PR Summary by Qodo</h3>\n<summary>  1.  Not a finding</summary>'), null);
  assert.equal(parseQodoReview('Thanks, fixed in abc1234.\n\n<h3>Code Review by Qodo</h3>'), null);
  assert.equal(parseQodoReview(''), null);
  assert.equal(parseQodoReview(undefined), null);
});

test('parseQodoReview: a review with no findings, and one without a commit', () => {
  assert.deepEqual(parseQodoReview(reviewBody()), { commit: SHA_A, findings: [] });
  assert.equal(parseQodoReview(reviewBody({ commit: null, open: ['A bug'] })).commit, null);
});

test('reviewOf: only a review of the newest commit counts', () => {
  const comments = [qodo('<h3>PR Summary by Qodo</h3>'), qodo(reviewBody({ commit: SHA_A, open: ['A bug', 'Another bug'] }))];
  assert.equal(reviewOf(comments, SHA_B), null);
  const review = reviewOf(comments, SHA_A);
  assert.equal(review.open.length, 2);
  assert.equal(reviewOf([qodo(reviewBody({ commit: SHA_B, resolved: ['A bug'] }))], SHA_B).open.length, 0);
  assert.equal(reviewOf([], SHA_A), null);
});

test('reviewOf: a comment that copies the review format is ignored unless the Qodo app wrote it', () => {
  const clean = reviewBody({ commit: SHA_A });
  assert.equal(reviewOf([{ body: clean, user: { login: 'visitor', type: 'User' } }], SHA_A), null);
  assert.equal(reviewOf([{ body: clean, user: { login: QODO_BOT, type: 'User' } }], SHA_A), null);
  assert.equal(reviewOf([{ body: clean }], SHA_A), null);
  const real = qodo(reviewBody({ commit: SHA_A, open: ['A bug'] }));
  assert.equal(reviewOf([real, { body: clean, user: { login: 'visitor', type: 'User' } }], SHA_A).open.length, 1);
});

/**
 * A review comment the way Qodo groups findings today: a severity badge, then
 * the findings under it, then the resolved ones in their own section.
 * @param {Array<[string, Array<[string, string]>]>} groups severity name, then [title, labels] for each finding
 */
function groupedReview(groups, resolved = []) {
  let n = 0;
  const finding = (title, labels) => {
    n += 1;
    return `<details>\n<summary>  ${n}.  ${title} ${labels}</summary>\n\n> <details>\n><summary>Description</summary>\n><br/>\n>\n><pre>\n>${title} happens.\n></pre>\n></details>\n\n<hr/>\n</details>\n`;
  };
  const body = groups
    .map(([severity, items]) => `<img src="https://img.shields.io/badge/${severity}-634FD1?style=flat-square" height="20px" alt="${severity}">\n\n${items.map(([title, labels]) => finding(title, labels)).join('\n')}`)
    .join('\n');
  const done = resolved.length
    ? `<details><summary><strong>Resolved findings</strong></summary>\n\n${resolved.map((title) => finding(`<s>${title}</s>`, '<code>✓ Resolved</code>')).join('\n')}</details>\n`
    : '';
  return `<h3>Code Review by Qodo</h3>\n\n<code>🐞 Bugs (1)</code> <code>📘 Rule violations (1)</code>\n\n${body}\n${done}\n<!-- https://github.com/owner/repo/commit/${SHA_A} -->\n`;
}

test('parseQodoReview: each finding has the severity of the group it is under, and its type', () => {
  const review = parseQodoReview(
    groupedReview(
      [
        ['High', [['Lock can be skipped', '<code>🐞 Bug</code> <code>⭐ New</code>']]],
        ['Medium', [['Ticket asks for a log line', '<code>📎 Requirement gap</code>']]],
        ['Low', [['Comment says 3 rounds', '<code>📘 Rule violation</code> <code>⭐ New</code>']]],
      ],
      ['Old bug'],
    ),
  );
  assert.deepEqual(
    review.findings.map((f) => [f.number, f.title, f.severity, f.kind, f.resolved]),
    [
      [1, 'Lock can be skipped', 'High', '🐞 Bug', false],
      [2, 'Ticket asks for a log line', 'Medium', '📎 Requirement gap', false],
      [3, 'Comment says 3 rounds', 'Low', '📘 Rule violation', false],
      [4, 'Old bug', null, '', true],
    ],
  );
});

test('parseQodoReview: the older "View medium" heading names a severity too, and a name the gate does not know is kept', () => {
  assert.equal(parseQodoReview(reviewBody({ open: ['A bug'] })).findings[0].severity, 'Medium');
  const odd = parseQodoReview(groupedReview([['Critical', [['Keys in the log', '<code>🐞 Bug</code>']]]]));
  assert.equal(odd.findings[0].severity, 'Critical');
  const none = parseQodoReview(`<h3>Code Review by Qodo</h3>\n<details>\n<summary>  1.  Bare <code>🐞 Bug</code></summary>\n</details>`);
  assert.equal(none.findings[0].severity, null);
  // Dismissed and outdated findings need no action, like resolved ones.
  const closed = parseQodoReview(groupedReview([['Medium', [['Gone', '<code>✗ Dismissed</code>'], ['Moved', '<code>⊖ Outdated</code>']]]]));
  assert.deepEqual(closed.findings.map((f) => f.resolved), [true, true]);
});

test('blocks: High, Medium and a severity the runner cannot read hold a task back, Low does not', () => {
  assert.equal(blocks({ severity: 'High' }), true);
  assert.equal(blocks({ severity: 'Medium' }), true);
  assert.equal(blocks({ severity: 'Critical' }), true);
  assert.equal(blocks({ severity: null }), true);
  assert.equal(blocks({ severity: 'Low' }), false);
});

test('reviewOf: splits the open findings into the ones the agent fixes and the Low ones for me', () => {
  const body = groupedReview(
    [
      ['Medium', [['Lock can be skipped', '<code>🐞 Bug</code>']]],
      ['Low', [['Comment says 3 rounds', '<code>📘 Rule violation</code>']]],
    ],
    ['Old bug'],
  );
  const review = reviewOf([qodo(body)], SHA_A);
  assert.deepEqual(review.open.map((f) => f.title), ['Lock can be skipped', 'Comment says 3 rounds']);
  assert.deepEqual(review.blocking.map((f) => f.title), ['Lock can be skipped']);
  assert.deepEqual(review.low.map((f) => f.title), ['Comment says 3 rounds']);
});

test('nextStep: Low findings alone end the run for my review, they never start a fix round', () => {
  const lowOnly = reviewOf([qodo(groupedReview([['Low', [['Comment says 3 rounds', '<code>📘 Rule violation</code>']]]]))], SHA_A);
  assert.equal(lowOnly.open.length, 1);
  assert.deepEqual(nextStep({ ci: 'passed', review: lowOnly, round: 0, waitedMs: 0 }), { step: 'review' });
  assert.deepEqual(nextStep({ ci: 'passed', review: lowOnly, round: 2, waitedMs: 0 }), { step: 'review' });
  const mixed = reviewOf([qodo(groupedReview([['High', [['A', '<code>🐞 Bug</code>']]], ['Low', [['B', '<code>🐞 Bug</code>']]]]))], SHA_A);
  assert.deepEqual(nextStep({ ci: 'passed', review: mixed, round: 0, waitedMs: 0 }), { step: 'fix' });
  assert.match(nextStep({ ci: 'passed', review: mixed, round: 2, waitedMs: 0 }).reason, /^1 High or Medium Qodo finding is still open/);
});

test('lowFindingsText: the Low findings listed for me on the ticket with title, type and file, or nothing', () => {
  assert.equal(lowFindingsText([]), '');
  assert.equal(
    lowFindingsText([
      { number: 3, title: 'Comment says 3 rounds', kind: '📘 Rule violation', severity: 'Low', files: ['factory/tick.js'] },
      { number: 4, title: 'Odd name', kind: '🐞 Bug', severity: 'Low', files: [] },
    ]),
    'Low findings for you. The agent left this code as it is:\n\n' +
      '- 3. Comment says 3 rounds (Low, 📘 Rule violation). File: `factory/tick.js`\n' +
      '- 4. Odd name (Low, 🐞 Bug). File: not named in the review',
  );
});

test('parseQodoReview: a finding\'s files are the paths its agent prompt names, or else its links', () => {
  const [finding] = parseQodoReview(reviewBody({ open: ['A bug'] })).findings;
  assert.deepEqual(finding.files, ['src/styles.js']);
  const linked = parseQodoReview(
    groupedReview([['Low', [['Odd name', '<code>🐞 Bug</code>']]]]).replace(
      '<hr/>',
      '<a href="https://github.com/owner/repo/blob/06714e664e0923d7a2037d1f87b59def4553a0ca/factory/tick.js#L10-L12">factory/tick.js[10-12]</a>\n<hr/>',
    ),
  );
  assert.deepEqual(linked.findings[0].files, ['factory/tick.js']);
  assert.deepEqual(parseQodoReview(groupedReview([['Low', [['Bare', '<code>🐞 Bug</code>']]]])).findings[0].files, []);
});

test('parseQodoReview: inline code in a title stays in the title and never closes the finding', () => {
  const review = parseQodoReview(
    groupedReview([
      [
        'High',
        [
          ['Check <code>isResolved</code> before the push', '<code>🐞 Bug</code> <code>⭐ New</code>'],
          ['Rename <code>wasDismissed</code>', '<code>📘 Rule violation</code>'],
        ],
      ],
    ]),
  );
  assert.deepEqual(
    review.findings.map((f) => [f.title, f.kind, f.severity, f.resolved]),
    [
      ['Check isResolved before the push', '🐞 Bug', 'High', false],
      ['Rename wasDismissed', '📘 Rule violation', 'High', false],
    ],
  );
  assert.equal(reviewOf([qodo(groupedReview([['High', [['Check <code>isResolved</code>', '<code>🐞 Bug</code>']]]]))], SHA_A).blocking.length, 1);
});

test('parseQodoReview: a badge or heading quoted inside a finding does not change the next finding\'s group', () => {
  const quoting = groupedReview([
    [
      'High',
      [
        ['Badge parser', '<code>🐞 Bug</code>'],
        ['Lock can be skipped', '<code>🐞 Bug</code>'],
      ],
    ],
  ]).replace(
    '>Badge parser happens.',
    '>Badge parser happens on img.shields.io/badge/Low-634FD1 and on <summary>View low (1)</summary> and\n>' +
      '<summary>Resolved findings</summary>',
  );
  const quotedPrompt = quoting.replace(
    '<hr/>',
    '> <details>\n><summary>Agent prompt</summary>\n>```\n>See img.shields.io/badge/Low-634FD1\n>```\n></details>\n<hr/>',
  );
  for (const body of [quoting, quotedPrompt]) {
    const review = reviewOf([qodo(body)], SHA_A);
    assert.deepEqual(review.findings.map((f) => f.severity), ['High', 'High']);
    assert.deepEqual(review.blocking.map((f) => f.title), ['Badge parser', 'Lock can be skipped']);
    assert.equal(review.low.length, 0);
  }
});

test('fixRoundText: the agent gets the High and Medium findings and never a Low one', () => {
  const review = reviewOf(
    [qodo(groupedReview([['Medium', [['Lock can be skipped', '<code>🐞 Bug</code>']]], ['Low', [['Comment says 3 rounds', '<code>📘 Rule violation</code>']]]]))],
    SHA_A,
  );
  const text = fixRoundText(review);
  assert.match(text, /^## 1\. Lock can be skipped \(Medium, 🐞 Bug\)/);
  assert.doesNotMatch(text, /Comment says 3 rounds/);
});

test('readyComment: the agent-review comment names the checks and lists the open Low findings', () => {
  const review = reviewOf([qodo(groupedReview([['Low', [['Comment says 3 rounds', '<code>📘 Rule violation</code>']]]]))], SHA_A);
  const text = readyComment({ pr: 26, head: SHA_A, found: 2, round: 1, low: review.low });
  const [ready, low] = text.split('\n\n');
  assert.equal(
    ready,
    `Pull request #26 is ready for you. \`npm test\`, \`npm run check\` and CI pass on ${SHA_A.slice(0, 7)}. Qodo raised 2 High or Medium findings and none are open. Fix rounds used: 1 of ${LIMITS.fixRounds}. It is not merged.`,
  );
  assert.equal(low, 'Low findings for you. The agent left this code as it is:');
  assert.match(text, /\n- 1\. Comment says 3 rounds \(Low, 📘 Rule violation\)\. File: not named in the review$/);
  const clean = readyComment({ pr: 26, head: SHA_A, found: 0, round: 0, low: [] });
  assert.match(clean, /Qodo had no High or Medium findings\. Fix rounds used: 0 of \d+\. It is not merged\.$/);
});

test('the fix prompt and AGENTS.md name the same quality gate', async () => {
  const fix = await readFile(new URL('../factory/prompts/fix.md', import.meta.url), 'utf8');
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(fix, /quality gate in `AGENTS\.md`/);
  assert.match(agents, /^## Quality gate$/m);
  const gate = agents.slice(agents.indexOf('## Quality gate'));
  for (const word of ['High', 'Medium', 'Low']) assert.match(gate, new RegExp(`\\b${word}\\b`));
});

test('ciState: pending until each check run finished', () => {
  const done = (conclusion) => ({ status: 'completed', conclusion });
  assert.equal(ciState([]), 'pending');
  assert.equal(ciState([{ status: 'in_progress', conclusion: null }]), 'pending');
  assert.equal(ciState([done('success'), { status: 'queued', conclusion: null }]), 'pending');
  assert.equal(ciState([done('success'), done('skipped')]), 'passed');
  assert.equal(ciState([done('success'), done('failure')]), 'failed');
  assert.equal(ciState([done('cancelled')]), 'failed');
});

test('nextStep: waits for CI and the review, then stops after 15 minutes', () => {
  const clean = { blocking: [] };
  assert.deepEqual(nextStep({ ci: 'pending', review: null, round: 0, waitedMs: 0 }), { step: 'wait' });
  assert.deepEqual(nextStep({ ci: 'passed', review: null, round: 0, waitedMs: 60000 }), { step: 'wait' });
  assert.deepEqual(nextStep({ ci: 'pending', review: clean, round: 0, waitedMs: 60000 }), { step: 'wait' });
  const late = nextStep({ ci: 'passed', review: null, run: { complete: true, error: null }, round: 0, waitedMs: LIMITS.reviewWaitMs });
  assert.equal(late.step, 'help');
  assert.equal(late.reason, "Qodo's review comment did not name the newest commit within 15 minutes.");
  assert.match(nextStep({ ci: 'pending', review: clean, round: 0, waitedMs: LIMITS.reviewWaitMs }).reason, /CI did not finish/);
});

/**
 * What `qodo read pr-review-session findings --pr-url <url> --json` prints,
 * in the shape of pull request #26: one review_session for the run.
 */
function qodoRead(session = {}, extra = {}) {
  return {
    code: 0,
    stderr: '',
    timedOut: false,
    stdout: JSON.stringify({
      review_session: session === null ? null : { run_id: 1932738, commit_sha: SHA_A, status: 'completed', review_complete: true, started_at: '2026-11-12T15:46:34Z', ...session },
      findings: [{ git_sha: SHA_B, action_level: 'action_required', attribution_status: 'implemented' }],
      ...extra,
    }),
  };
}

test('qodoRunArgs: the qodo read of the review run on a pull request, as JSON', () => {
  assert.deepEqual(qodoRunArgs('https://github.com/owner/repo/pull/26'), [
    'read', 'pr-review-session', 'findings', '--pr-url', 'https://github.com/owner/repo/pull/26', '--json',
  ]);
  assert.equal(LIMITS.qodoMs, 30 * 1000);
});

test('reviewRunState: complete only when the session names the head, reads completed and says review_complete', () => {
  assert.deepEqual(reviewRunState(qodoRead(), SHA_A), { complete: true, error: null });
  assert.deepEqual(reviewRunState(qodoRead({ status: 'started', review_complete: false }), SHA_A), { complete: false, error: null });
  assert.deepEqual(reviewRunState(qodoRead({ status: 'completed', review_complete: false }), SHA_A), { complete: false, error: null });
  assert.deepEqual(reviewRunState(qodoRead({ status: 'failed' }), SHA_A), { complete: false, error: null });
  assert.deepEqual(reviewRunState(qodoRead({ review_complete: 'true' }), SHA_A), { complete: false, error: null });
  // A completed run on the commit before the push doesn't count for the head.
  assert.deepEqual(reviewRunState(qodoRead(), SHA_B), { complete: false, error: null });
  // No review yet, and a read Qodo cut short.
  assert.deepEqual(reviewRunState(qodoRead(null), SHA_A), { complete: false, error: null });
  assert.deepEqual(reviewRunState(qodoRead({}, { qar_operation_result_truncated: true }), SHA_A), { complete: false, error: null });
  // A finding's git_sha names where it was first raised, never the commit the run covers.
  assert.equal(reviewRunState(qodoRead({ commit_sha: SHA_B }), SHA_B).complete, true);
  assert.equal(reviewRunState(qodoRead({ commit_sha: SHA_A }), SHA_B).complete, false);
});

test('reviewRunState: a failed qodo read is not complete and keeps a short error', () => {
  const failed = reviewRunState({ code: 1, stdout: '{"error":{"code":"MT-UPSTREAM-DOWN"}}', stderr: '' }, SHA_A);
  assert.deepEqual(failed, { complete: false, error: '{"error":{"code":"MT-UPSTREAM-DOWN"}}' });
  assert.match(reviewRunState({ code: 0, stdout: 'Please sign in', stderr: '' }, SHA_A).error, /^qodo did not print JSON: Please sign in$/);
  assert.match(reviewRunState({ code: 0, stdout: 'null', stderr: '' }, SHA_A).error, /not print a JSON object/);
  assert.match(reviewRunState({ code: 0, stdout: '{"error":{"code":"AUTH"}}', stderr: '' }, SHA_A).error, /AUTH/);
  assert.equal(reviewRunState({ code: 1, stdout: '', stderr: '', timedOut: true }, SHA_A).error, 'qodo did not answer in time.');
  assert.match(reviewRunState({ code: 1, stdout: '', stderr: '', message: 'spawn qodo ENOENT' }, SHA_A).error, /ENOENT/);
  assert.equal(reviewRunState({ code: 3, stdout: '', stderr: '' }, SHA_A).error, 'qodo exited with code 3.');
  const long = reviewRunState({ code: 1, stdout: '', stderr: `x\n${'y'.repeat(1000)}` }, SHA_A).error;
  assert.equal(long.length, 300);
  assert.match(long, /^x y+…$/);
});

test('reviewFor: a comment that names the head does not count while the run on the head is not complete', () => {
  const comments = [qodo(groupedReview([['High', [['Lock can be skipped', '<code>🐞 Bug</code>']]]]))];
  const started = reviewRunState(qodoRead({ status: 'started', review_complete: false }), SHA_A);
  assert.equal(reviewOf(comments, SHA_A).blocking.length, 1);
  assert.equal(reviewFor(comments, SHA_A, started), null);
  assert.equal(reviewFor(comments, SHA_A, reviewRunState(qodoRead(null), SHA_A)), null);
  assert.equal(reviewFor(comments, SHA_A, { complete: false, error: 'qodo did not answer in time.' }), null);
  // The runner keeps waiting while the run is started, the same as with no review.
  assert.deepEqual(nextStep({ ci: 'passed', review: reviewFor(comments, SHA_A, started), run: started, round: 0, waitedMs: 3 * 60000 }), { step: 'wait' });
  // Once the run on the head is complete, the comment's findings count.
  const done = reviewRunState(qodoRead(), SHA_A);
  assert.deepEqual(reviewFor(comments, SHA_A, done).blocking.map((f) => f.title), ['Lock can be skipped']);
  assert.deepEqual(nextStep({ ci: 'passed', review: reviewFor(comments, SHA_A, done), run: done, round: 0, waitedMs: 3 * 60000 }), { step: 'fix' });
  // A completed run doesn't make an older commit's comment count.
  assert.equal(reviewFor(comments, SHA_B, reviewRunState(qodoRead({ commit_sha: SHA_B }), SHA_B)), null);
});

test('nextStep: a review run that never completes stops after the same 15 minutes, with the last qodo error', () => {
  const started = { complete: false, error: null };
  assert.deepEqual(nextStep({ ci: 'passed', review: null, run: started, round: 0, waitedMs: LIMITS.reviewWaitMs - 1 }), { step: 'wait' });
  const late = nextStep({ ci: 'passed', review: null, run: started, round: 0, waitedMs: LIMITS.reviewWaitMs });
  assert.deepEqual(late, { step: 'help', reason: "Qodo's review run on the newest commit did not complete within 15 minutes." });
  const failing = nextStep({ ci: 'passed', review: null, run: { complete: false, error: 'spawn qodo ENOENT' }, round: 0, waitedMs: LIMITS.reviewWaitMs });
  assert.equal(failing.reason, "Qodo's review run on the newest commit did not complete within 15 minutes. The last qodo error: spawn qodo ENOENT");
  // CI that hasn't finished is named first.
  assert.match(nextStep({ ci: 'pending', review: null, run: started, round: 0, waitedMs: LIMITS.reviewWaitMs }).reason, /^CI did not finish/);
});

test('carryRunError: a failed read followed by reads that work keeps its error for the stop reason', () => {
  const failed = reviewRunState({ code: 1, stdout: '{"error":{"code":"MT-UPSTREAM-DOWN"}}', stderr: '' }, SHA_A);
  const started = reviewRunState(qodoRead({ status: 'started', review_complete: false }), SHA_A);
  let state = carryRunError(null, started);
  assert.deepEqual(state, { complete: false, error: null });
  state = carryRunError(state, failed);
  state = carryRunError(state, started);
  state = carryRunError(state, started);
  assert.deepEqual(state, { complete: false, error: '{"error":{"code":"MT-UPSTREAM-DOWN"}}' });
  assert.equal(
    nextStep({ ci: 'passed', review: null, run: state, round: 0, waitedMs: LIMITS.reviewWaitMs }).reason,
    'Qodo\'s review run on the newest commit did not complete within 15 minutes. The last qodo error: {"error":{"code":"MT-UPSTREAM-DOWN"}}',
  );
  // A newer error replaces the older one, and a complete run is complete whatever failed before.
  assert.equal(carryRunError(state, { complete: false, error: 'qodo did not answer in time.' }).error, 'qodo did not answer in time.');
  assert.equal(carryRunError(state, reviewRunState(qodoRead(), SHA_A)).complete, true);
});

test('qodoCall: the qodo command, the read of the review run and a 30-second timeout', () => {
  assert.deepEqual(qodoCall('qodo', 'https://github.com/owner/repo/pull/26'), {
    command: 'qodo',
    args: qodoRunArgs('https://github.com/owner/repo/pull/26'),
    options: { timeout: 30 * 1000 },
  });
  assert.equal(qodoCall('/opt/qodo/bin/qodo', 'u').command, '/opt/qodo/bin/qodo');
});

test('reviewPoll: one wait through an outage logs each qodo error once, keeps it, and counts the review once the run completes', () => {
  const comments = [qodo(groupedReview([['Medium', [['Lock can be skipped', '<code>🐞 Bug</code>']]]]))];
  const down = { code: 1, stdout: '{"error":{"code":"MT-UPSTREAM-DOWN"}}', stderr: '' };
  const started = qodoRead({ status: 'started', review_complete: false });
  const reads = [started, down, down, started, down, qodoRead()];
  let previous = null;
  let lastLogged = null;
  const logged = [];
  const steps = [];
  reads.forEach((result, i) => {
    const poll = reviewPoll({ previous, lastLogged, result, comments, head: SHA_A, ci: 'passed', round: 0, waitedMs: i * LIMITS.pollMs });
    if (poll.logError) logged.push(poll.logError);
    ({ run: previous, lastLogged } = poll);
    steps.push([poll.next.step, poll.run.error, poll.review ? poll.review.blocking.length : null]);
  });
  const error = '{"error":{"code":"MT-UPSTREAM-DOWN"}}';
  // Logged when it starts, not on the poll after, and again when it comes back after a read that worked.
  assert.deepEqual(logged, [error, error]);
  assert.deepEqual(steps, [
    ['wait', null, null],
    ['wait', error, null],
    ['wait', error, null],
    ['wait', error, null],
    ['wait', error, null],
    ['fix', error, 1],
  ]);
  // Time runs out while the run is started after the outage: the stop reason keeps the error.
  const late = reviewPoll({ previous: { complete: false, error }, lastLogged: null, result: started, comments, head: SHA_A, ci: 'passed', round: 0, waitedMs: LIMITS.reviewWaitMs });
  assert.equal(late.logError, null);
  assert.equal(late.review, null);
  assert.deepEqual(late.next, { step: 'help', reason: `Qodo's review run on the newest commit did not complete within 15 minutes. The last qodo error: ${error}` });
});

test('nextStep: failed CI stops the run, a clean review ends it', () => {
  assert.equal(nextStep({ ci: 'failed', review: { blocking: [] }, round: 0, waitedMs: 0 }).step, 'help');
  assert.equal(nextStep({ ci: 'failed', review: null, round: 0, waitedMs: 0 }).step, 'help');
  assert.deepEqual(nextStep({ ci: 'passed', review: { blocking: [] }, round: 0, waitedMs: 0 }), { step: 'review' });
  assert.deepEqual(nextStep({ ci: 'passed', review: { blocking: [] }, round: 2, waitedMs: 0 }), { step: 'review' });
});

test('nextStep: the agent gets 2 fix rounds for open High and Medium findings', () => {
  const one = { blocking: [{}] };
  assert.equal(LIMITS.fixRounds, 2);
  assert.deepEqual(nextStep({ ci: 'passed', review: one, round: 0, waitedMs: 0 }), { step: 'fix' });
  assert.deepEqual(nextStep({ ci: 'passed', review: one, round: 1, waitedMs: 0 }), { step: 'fix' });
  const stopped = nextStep({ ci: 'passed', review: one, round: 2, waitedMs: 0 });
  assert.equal(stopped.step, 'help');
  assert.equal(stopped.reason, '1 High or Medium Qodo finding is still open after 2 fix rounds.');
  assert.match(nextStep({ ci: 'passed', review: { blocking: [{}, {}] }, round: 2, waitedMs: 0 }).reason, /^2 High or Medium Qodo findings are/);
});

test('fillPrompt: fills each place and refuses a name it has no value for', () => {
  assert.equal(fillPrompt('Ticket #{{number}} on {{branch}}, #{{number}} again.', { number: 8, branch: '8-lock' }), 'Ticket #8 on 8-lock, #8 again.');
  assert.throws(() => fillPrompt('PR #{{pr}}', { number: 8 }), /asks for "pr"/);
  assert.equal(fillPrompt('No places.', {}), 'No places.');
});

test('findingsText: what the agent reads in a fix round', () => {
  const { findings } = parseQodoReview(reviewBody({ open: ['A bug', 'Another bug'] }));
  const text = findingsText(findings);
  assert.match(text, /^## 1\. A bug \(Medium, 🐞 Bug\)\n\npickStyle reads/);
  assert.match(text, /## 2\. Another bug/);
  assert.match(text, /Qodo's suggested prompt:\n\n## Issue description\nFix Another bug\./);
  assert.equal(findingsText([{ number: 1, title: 'Bare', kind: '', description: '', prompt: '' }]), '## 1. Bare');
});

test('each prompt file is filled by the values the runner passes for it', async () => {
  const run = { number: 8, repo: 'owner/repo', branch: '8-lock', notes: '.factory-run', criteria: ['It locks.'], check: 'npm test', output: 'not ok 1', pr: 11 };
  const files = (await readdir(new URL('../factory/prompts/', import.meta.url))).sort();
  assert.deepEqual(files, ['build.md', 'failed-check.md', 'fix.md']);
  for (const file of files) {
    const template = await readFile(new URL(`../factory/prompts/${file}`, import.meta.url), 'utf8');
    const values = promptValues(file, run);
    // Each place in the file has a value, and the runner passes no value the file doesn't use.
    assert.deepEqual(promptPlaces(template).sort(), Object.keys(values).sort(), file);
    const filled = fillPrompt(template, values);
    assert.doesNotMatch(filled, /\{\{|undefined/, file);
    assert.match(filled, /#8\b/, file);
  }
});

test('promptValues: each file gets its own values, and an unknown file is an error', () => {
  const run = { number: 8, repo: 'owner/repo', branch: '8-lock', notes: '.factory-run', criteria: ['Each group has a lock.', '`npm test` passes.'] };
  assert.deepEqual(promptValues('build.md', { ...run, pr: 11 }), {
    number: 8,
    branch: '8-lock',
    notes: '.factory-run',
    repo: 'owner/repo',
    criteria: '1. Each group has a lock.\n2. `npm test` passes.',
  });
  // A build prompt without criteria would ask the agent to meet an empty list.
  assert.throws(() => promptValues('build.md', { ...run, criteria: [] }), /no acceptance criteria/);
  assert.throws(() => promptValues('build.md', { ...run, criteria: undefined }), /no acceptance criteria/);
  assert.deepEqual(promptValues('fix.md', { ...run, pr: 11 }), { number: 8, branch: '8-lock', notes: '.factory-run', pr: 11 });
  assert.deepEqual(Object.keys(promptValues('failed-check.md', run)), ['number', 'branch', 'notes', 'check', 'output']);
  // The pull request number doesn't exist before the first push, and a prompt that needs it fails to fill.
  assert.throws(() => fillPrompt('PR #{{pr}}', promptValues('build.md', run)), /asks for "pr"/);
  assert.throws(() => promptValues('merge.md', run), /no prompt file named "merge.md"/);
});

test('the build prompt and the pull request description carry the same criteria, without the collapsed ones', async () => {
  // The shape of ticket #18 again: the list that counts, then the first wording in a collapsed block.
  const ticket = [
    '## Acceptance criteria',
    '',
    '1. A Size picker next to Download lists Full size first.',
    '2. The file name for GitHub ends with `$&-500.png`.',
    '',
    '<details>',
    '<summary>Original wording</summary>',
    '',
    '## Acceptance criteria',
    '',
    '1. A Size picker offers GitHub, Slack and Full size.',
    '',
    '</details>',
  ].join('\n');
  const criteria = acceptanceCriteria(ticket);
  const list = criteriaList(criteria);
  assert.equal(list, '1. A Size picker next to Download lists Full size first.\n2. The file name for GitHub ends with `$&-500.png`.');
  const template = await readFile(new URL('../factory/prompts/build.md', import.meta.url), 'utf8');
  const prompt = fillPrompt(template, promptValues('build.md', { number: 18, repo: 'owner/repo', branch: '18-size', notes: '.factory-run', criteria }));
  const description = prBody(18, criteria, 'It adds a picker.');
  assert.ok(prompt.includes(`\n\n${list}\n\n`));
  assert.ok(description.includes(`\n\n${list}\n\n`));
  assert.doesNotMatch(prompt, /Slack/);
  assert.doesNotMatch(description, /Slack/);
});

test('promptPlaces: the names a prompt asks for, each once', () => {
  assert.deepEqual(promptPlaces('#{{number}} on {{branch}}, #{{number}} again'), ['number', 'branch']);
  assert.deepEqual(promptPlaces('No places.'), []);
});
