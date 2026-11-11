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
  branchFor,
  candidates,
  ciState,
  fillPrompt,
  findingsText,
  guardedFiles,
  labelledBy,
  lockCommand,
  nextStep,
  parseQodoReview,
  prBody,
  promptPlaces,
  promptValues,
  reviewOf,
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
  const clean = { open: [] };
  assert.deepEqual(nextStep({ ci: 'pending', review: null, round: 0, waitedMs: 0 }), { step: 'wait' });
  assert.deepEqual(nextStep({ ci: 'passed', review: null, round: 0, waitedMs: 60000 }), { step: 'wait' });
  assert.deepEqual(nextStep({ ci: 'pending', review: clean, round: 0, waitedMs: 60000 }), { step: 'wait' });
  const late = nextStep({ ci: 'passed', review: null, round: 0, waitedMs: LIMITS.reviewWaitMs });
  assert.equal(late.step, 'help');
  assert.match(late.reason, /Qodo did not review the newest commit within 15 minutes/);
  assert.match(nextStep({ ci: 'pending', review: clean, round: 0, waitedMs: LIMITS.reviewWaitMs }).reason, /CI did not finish/);
});

test('nextStep: failed CI stops the run, a clean review ends it', () => {
  assert.equal(nextStep({ ci: 'failed', review: { open: [] }, round: 0, waitedMs: 0 }).step, 'help');
  assert.equal(nextStep({ ci: 'failed', review: null, round: 0, waitedMs: 0 }).step, 'help');
  assert.deepEqual(nextStep({ ci: 'passed', review: { open: [] }, round: 0, waitedMs: 0 }), { step: 'review' });
  assert.deepEqual(nextStep({ ci: 'passed', review: { open: [] }, round: 2, waitedMs: 0 }), { step: 'review' });
});

test('nextStep: the agent gets 2 fix rounds for open findings', () => {
  const one = { open: [{}] };
  assert.equal(LIMITS.fixRounds, 2);
  assert.deepEqual(nextStep({ ci: 'passed', review: one, round: 0, waitedMs: 0 }), { step: 'fix' });
  assert.deepEqual(nextStep({ ci: 'passed', review: one, round: 1, waitedMs: 0 }), { step: 'fix' });
  const stopped = nextStep({ ci: 'passed', review: one, round: 2, waitedMs: 0 });
  assert.equal(stopped.step, 'help');
  assert.equal(stopped.reason, '1 Qodo finding is still open after 2 fix rounds.');
  assert.match(nextStep({ ci: 'passed', review: { open: [{}, {}] }, round: 2, waitedMs: 0 }).reason, /^2 Qodo findings are/);
});

test('fillPrompt: fills each place and refuses a name it has no value for', () => {
  assert.equal(fillPrompt('Ticket #{{number}} on {{branch}}, #{{number}} again.', { number: 8, branch: '8-lock' }), 'Ticket #8 on 8-lock, #8 again.');
  assert.throws(() => fillPrompt('PR #{{pr}}', { number: 8 }), /asks for "pr"/);
  assert.equal(fillPrompt('No places.', {}), 'No places.');
});

test('findingsText: what the agent reads in a fix round', () => {
  const { findings } = parseQodoReview(reviewBody({ open: ['A bug', 'Another bug'] }));
  const text = findingsText(findings);
  assert.match(text, /^## 1\. A bug \(🐞 Bug\)\n\npickStyle reads/);
  assert.match(text, /## 2\. Another bug/);
  assert.match(text, /Qodo's suggested prompt:\n\n## Issue description\nFix Another bug\./);
  assert.equal(findingsText([{ number: 1, title: 'Bare', kind: '', description: '', prompt: '' }]), '## 1. Bare');
});

test('each prompt file is filled by the values the runner passes for it', async () => {
  const run = { number: 8, repo: 'owner/repo', branch: '8-lock', notes: '.factory-run', check: 'npm test', output: 'not ok 1', pr: 11 };
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
  const run = { number: 8, repo: 'owner/repo', branch: '8-lock', notes: '.factory-run' };
  assert.deepEqual(promptValues('build.md', { ...run, pr: 11 }), { number: 8, branch: '8-lock', notes: '.factory-run', repo: 'owner/repo' });
  assert.deepEqual(promptValues('fix.md', { ...run, pr: 11 }), { number: 8, branch: '8-lock', notes: '.factory-run', pr: 11 });
  assert.deepEqual(Object.keys(promptValues('failed-check.md', run)), ['number', 'branch', 'notes', 'check', 'output']);
  // The pull request number doesn't exist before the first push, and a prompt that needs it fails to fill.
  assert.throws(() => fillPrompt('PR #{{pr}}', promptValues('build.md', run)), /asks for "pr"/);
  assert.throws(() => promptValues('merge.md', run), /no prompt file named "merge.md"/);
});

test('promptPlaces: the names a prompt asks for, each once', () => {
  assert.deepEqual(promptPlaces('#{{number}} on {{branch}}, #{{number}} again'), ['number', 'branch']);
  assert.deepEqual(promptPlaces('No places.'), []);
});
