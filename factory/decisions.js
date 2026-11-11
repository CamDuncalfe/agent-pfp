/**
 * The decisions the factory runner makes, kept apart from the commands it
 * runs. factory/tick.js calls these with what GitHub returned and does what
 * they say. docs/factory.md describes the whole run.
 */

/** The label on a ticket says where its run is. */
export const LABELS = Object.freeze({
  ready: 'ready-for-agent',
  working: 'agent-working',
  review: 'agent-review',
  help: 'agent-needs-help',
});

export const LIMITS = Object.freeze({
  /** Fix rounds the agent gets after the first pull request. */
  fixRounds: 2,
  /** How long the runner waits for CI and Qodo's review of one commit. */
  reviewWaitMs: 15 * 60 * 1000,
  /** How long one agent call may take. */
  agentMs: 20 * 60 * 1000,
  pollMs: 30 * 1000,
});

/** Qodo's reviews are comments by this app. */
export const QODO_BOT = 'qodo-code-review[bot]';

/** The agent may not change the runner or the CI workflow that check its work. */
export const GUARDED_FOLDERS = Object.freeze(['factory/', '.github/']);

/** The built-in tools the agent has at all. Claude Code loads no other tool for it. */
export const AGENT_BUILTIN_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);

/**
 * What the agent may do without a person there to approve it. Reading the
 * ticket is on the list. Pushing, merging and each gh command that writes
 * are left off, so the runner does those after its own checks.
 */
export const AGENT_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(npm ci)',
  'Bash(npm test)',
  'Bash(npm test:*)',
  'Bash(npm run check)',
  'Bash(npm run check:*)',
  'Bash(node --test:*)',
  'Bash(node bin/render-check.js:*)',
  'Bash(node bin/check-styles.js:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(gh issue view:*)',
  'Bash(gh issue list:*)',
  'Bash(gh pr view:*)',
]);

/** The file tools are refused in the guarded folders, whatever else is allowed. */
export const AGENT_DENIED = Object.freeze(GUARDED_FOLDERS.flatMap((folder) => [`Edit(${folder}**)`, `Write(${folder}**)`]));

/**
 * The arguments for one unattended Claude Code call. The prompt goes in on
 * standard input.
 *
 * --allowedTools on its own only approves tools ahead of time, and a
 * permission saved in a settings file on the Mac would add to it. So the
 * call also loads no settings file and no MCP server, limits the built-in
 * tools, and has nobody to ask: a command that is not on the list is refused.
 * @param {{ model?: string, session?: string }} [options] session is the id of an earlier call to carry on from
 */
export function agentArgs({ model, session } = {}) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--permission-prompts', 'none',
    '--tools', AGENT_BUILTIN_TOOLS.join(','),
    '--allowedTools', ...AGENT_TOOLS,
    '--disallowedTools', ...AGENT_DENIED,
  ];
  if (model) args.push('--model', model);
  if (session) args.push('--resume', session);
  return args;
}

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => label.name);
}

/**
 * The tickets a tick may take, lowest number first, and the ones it leaves
 * alone with the reason. Only an open ticket the owner opened counts.
 * @param {Array<{number: number, state?: string, user?: {login: string}, pull_request?: object, labels?: Array<{name: string}>}>} issues
 *   issues as the GitHub REST API lists them, which includes pull requests
 * @param {string} owner the repository owner's login
 */
export function candidates(issues, owner) {
  const tickets = [];
  const skipped = [];
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const names = labelNames(issue);
    if (!names.includes(LABELS.ready)) continue;
    if (issue.pull_request) {
      skipped.push({ number: issue.number, reason: 'it is a pull request' });
    } else if (issue.state && issue.state.toLowerCase() !== 'open') {
      skipped.push({ number: issue.number, reason: 'it is closed' });
    } else if (names.includes(LABELS.working)) {
      skipped.push({ number: issue.number, reason: `it also has the ${LABELS.working} label` });
    } else if (issue.user?.login !== owner) {
      skipped.push({ number: issue.number, reason: `${issue.user?.login ?? 'someone else'} opened it, not ${owner}` });
    } else {
      tickets.push(issue);
    }
  }
  return { tickets, skipped };
}

/**
 * Who put the label on the ticket, from the issue's events (oldest first).
 * Null when the label was never added or was taken off again.
 * @param {Array<{event: string, label?: {name: string}, actor?: {login: string}}>} events
 * @param {string} label
 */
export function labelledBy(events, label) {
  let login = null;
  for (const event of events) {
    if (event.label?.name !== label) continue;
    if (event.event === 'labeled') login = event.actor?.login ?? null;
    if (event.event === 'unlabeled') login = null;
  }
  return login;
}

/**
 * The numbered acceptance criteria of a ticket, in order. They are the
 * numbered lines under a heading that reads "Acceptance criteria". A
 * collapsed <details> block is left out with its headings, because a ticket
 * keeps wording there that no longer counts, such as its first version.
 * @param {string} body
 */
export function acceptanceCriteria(body) {
  const criteria = [];
  let inSection = false;
  let collapsed = 0;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const opened = (line.match(/<details[\s>]/gi) ?? []).length;
    const closed = (line.match(/<\/details\s*>/gi) ?? []).length;
    if (collapsed > 0 || opened > 0) {
      collapsed = Math.max(0, collapsed + opened - closed);
      continue;
    }
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading) {
      inSection = /^acceptance criteria$/i.test(heading[1]);
      continue;
    }
    const item = /^\s*\d+[.)]\s+(\S.*?)\s*$/.exec(line);
    if (inSection && item) criteria.push(item[1]);
  }
  return criteria;
}

/** What stops the agent from starting on this ticket. An empty list means it can start. */
export function ticketProblems(issue) {
  const problems = [];
  if (!String(issue.title ?? '').trim()) problems.push('The ticket has no title.');
  if (acceptanceCriteria(issue.body).length === 0) {
    problems.push('The ticket has no numbered list under an "Acceptance criteria" heading.');
  }
  return problems;
}

/** The branch for a ticket: its number and a short form of its title, like 3-style-picker. */
export function branchFor(issue) {
  const words = String(issue.title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 40) break;
    slug = next;
  }
  return slug ? `${issue.number}-${slug}` : `${issue.number}-ticket`;
}

/** The files of a change that sit in a folder the agent may not touch. */
export function guardedFiles(files) {
  return files.filter((file) => GUARDED_FOLDERS.some((folder) => file.startsWith(folder)));
}

/**
 * The command that runs another command while it holds the lock file. The
 * operating system gives the lock to one process at a time and takes it back
 * when that process ends, so a run that was cut off leaves nothing to clean up.
 * @returns {{ command: string, args: string[], heldExit: number }} heldExit is the exit code that means another run has the lock
 */
export function lockCommand(platform, lockFile) {
  if (platform === 'darwin' || platform === 'freebsd') {
    // -k keeps the file, so two runs never lock two different files of one name.
    return { command: 'lockf', args: ['-k', '-s', '-t', '0', lockFile], heldExit: 75 };
  }
  return { command: 'flock', args: ['--nonblock', '--conflict-exit-code', '75', lockFile], heldExit: 75 };
}

/**
 * The pull request description: the ticket it closes, the ticket's
 * acceptance criteria word for word, then what the agent wrote.
 */
export function prBody(number, criteria, description) {
  return [
    `Closes #${number}`,
    `## Acceptance criteria from the ticket\n\n${criteria.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n')}`,
    String(description).trim(),
  ].join('\n\n') + '\n';
}

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&amp;': '&' };

function plainText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|quot|#x27|#39|amp);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, ' ')
    .trim();
}

/** The lines of a quoted block ("> text") without the quote marks. */
function unquote(block) {
  return block
    .split(/\r?\n/)
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n');
}

/**
 * Read one of Qodo's "Code Review" comments: the commit it reviewed and its
 * numbered findings. Null when the comment is something else, for example
 * Qodo's summary of the pull request.
 * @param {string} body
 * @returns {{ commit: string | null, findings: Array<{ number: number, title: string, kind: string, resolved: boolean, description: string, prompt: string }> } | null}
 */
export function parseQodoReview(body) {
  const text = String(body ?? '');
  if (!/^\s*<h3>Code Review by Qodo<\/h3>/.test(text)) return null;

  const commits = [...text.matchAll(/<!--\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{40})\s*-->/g)];
  const commit = commits.length ? commits[commits.length - 1][1] : null;

  const heads = [...text.matchAll(/<summary>\s*(\d+)\.\s+([\s\S]*?)<\/summary>/g)];
  const findings = heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const section = unquote(text.slice(head.index + head[0].length, end));
    const kind = /<code>([\s\S]*?)<\/code>\s*$/.exec(head[2]);
    const title = kind ? head[2].slice(0, kind.index) : head[2];
    const description = /<summary>Description<\/summary>[\s\S]*?<pre>([\s\S]*?)<\/pre>/.exec(section);
    const prompt = /<summary>Agent prompt<\/summary>[\s\S]*?```\n([\s\S]*?)\n```/.exec(section);
    return {
      number: Number(head[1]),
      title: plainText(title),
      kind: kind ? plainText(kind[1]) : '',
      resolved: /<s>/.test(head[2]) || /Resolved/.test(kind?.[1] ?? ''),
      description: description ? plainText(description[1]) : '',
      prompt: prompt ? prompt[1].trim() : '',
    };
  });
  return { commit, findings };
}

/**
 * Qodo's review of one commit, from the pull request's comments. Null while
 * the newest review is still for an older commit. A comment only counts when
 * the Qodo app wrote it.
 * @param {Array<{ body: string, user?: { login: string, type?: string } }>} comments
 * @param {string} head the full SHA of the commit to look for
 */
export function reviewOf(comments, head) {
  let found = null;
  for (const comment of comments) {
    if (comment.user?.login !== QODO_BOT || comment.user?.type !== 'Bot') continue;
    const review = parseQodoReview(comment.body);
    if (review && review.commit === head) found = review;
  }
  if (!found) return null;
  return { ...found, open: found.findings.filter((finding) => !finding.resolved) };
}

/**
 * CI on one commit, from its check runs: "pending" until each one finished,
 * then "passed" or "failed". No check runs yet also reads as "pending".
 * @param {Array<{ status: string, conclusion: string | null }>} checkRuns
 */
export function ciState(checkRuns) {
  if (checkRuns.length === 0) return 'pending';
  if (checkRuns.some((run) => run.status !== 'completed')) return 'pending';
  const fine = ['success', 'neutral', 'skipped'];
  return checkRuns.every((run) => fine.includes(run.conclusion)) ? 'passed' : 'failed';
}

/**
 * What the runner does next with an open pull request.
 * @param {{ ci: 'pending' | 'passed' | 'failed', review: { open: unknown[] } | null, round: number, waitedMs: number }} state
 *   round is the number of fix rounds already used
 * @returns {{ step: 'wait' | 'fix' | 'review' | 'help', reason?: string }}
 */
export function nextStep({ ci, review, round, waitedMs }, limits = LIMITS) {
  if (ci === 'failed') return { step: 'help', reason: 'CI failed on the pull request.' };
  if (ci === 'pending' || !review) {
    if (waitedMs >= limits.reviewWaitMs) {
      const minutes = Math.round(limits.reviewWaitMs / 60000);
      const missing = ci === 'pending' ? 'CI did not finish' : 'Qodo did not review the newest commit';
      return { step: 'help', reason: `${missing} within ${minutes} minutes.` };
    }
    return { step: 'wait' };
  }
  if (review.open.length === 0) return { step: 'review' };
  if (round >= limits.fixRounds) {
    const count = review.open.length;
    return {
      step: 'help',
      reason: `${count} Qodo ${count === 1 ? 'finding is' : 'findings are'} still open after ${limits.fixRounds} fix rounds.`,
    };
  }
  return { step: 'fix' };
}

/** Fill the {{name}} places of a prompt file. A name without a value is an error. */
export function fillPrompt(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`The prompt asks for "${name}" and the runner has no value for it.`);
    return String(values[name]);
  });
}

/**
 * The values the runner fills into one prompt file. tick.js builds each
 * prompt through this, so the test that fills the files with it sees what a
 * run sees.
 * @param {'build.md' | 'failed-check.md' | 'fix.md'} file
 * @param {{ number: number, repo: string, branch: string, notes: string, check?: string, output?: string, pr?: number }} run
 */
export function promptValues(file, run) {
  const base = { number: run.number, branch: run.branch, notes: run.notes };
  if (file === 'build.md') return { ...base, repo: run.repo };
  if (file === 'failed-check.md') return { ...base, check: run.check, output: run.output };
  if (file === 'fix.md') return { ...base, pr: run.pr };
  throw new Error(`The runner has no prompt file named "${file}".`);
}

/** The names a prompt file asks for, each one once. */
export function promptPlaces(template) {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))];
}

/** Open findings as the text the agent gets in a fix round. */
export function findingsText(findings) {
  return findings
    .map((finding) =>
      [
        `## ${finding.number}. ${finding.title}${finding.kind ? ` (${finding.kind})` : ''}`,
        finding.description,
        finding.prompt ? `Qodo's suggested prompt:\n\n${finding.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n');
}
