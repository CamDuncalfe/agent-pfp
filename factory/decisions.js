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
  /** How long one read of Qodo's review run may take. */
  qodoMs: 30 * 1000,
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
 *
 * A block opens where a line starts with the <details> tag. The tag named in
 * a sentence, in `inline code` or in a fenced code block opens nothing, so a
 * ticket can write about the tag and keep its criteria. A tag inside an HTML
 * comment, on one line or over several, neither opens nor closes a block.
 * A numbered line inside a comment still counts as a criterion.
 * @param {string} body
 */
export function acceptanceCriteria(body) {
  const criteria = [];
  let inSection = false;
  let collapsed = 0;
  let fence = null;
  let comment = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const mark = comment ? null : /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // A fence ends on a line of the same marks, at least as many, and nothing after them.
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    } else if (mark && !(mark[1][0] === '`' && mark[2].includes('`'))) {
      fence = mark[1];
    } else {
      // The line without inline code and without comments. A comment left open carries on in the next line.
      let tags = `${comment ? '<!--' : ''}${line.replace(/(`+).*?\1/g, '')}`.replace(/<!--.*?-->/g, '');
      comment = tags.includes('<!--');
      if (comment) tags = tags.slice(0, tags.indexOf('<!--'));
      const opens = collapsed > 0 || /^ {0,3}<details(?=[\s>]|$)/i.test(tags);
      const opened = opens ? (tags.match(/<details(?=[\s>]|$)/gi) ?? []).length : 0;
      const closed = collapsed > 0 || opened > 0 ? (tags.match(/<\/details\s*>/gi) ?? []).length : 0;
      if (collapsed > 0 || opened > 0) {
        collapsed = Math.max(0, collapsed + opened - closed);
        continue;
      }
    }
    if (collapsed > 0) continue;
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
 * The criteria as a numbered list, one per line. The build prompt and the
 * pull request description both get this text, so the agent is asked to meet
 * the list the description shows, under the same numbers.
 * @param {string[]} criteria
 */
export function criteriaList(criteria) {
  return criteria.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n');
}

/**
 * The pull request description: the ticket it closes, the ticket's
 * acceptance criteria word for word, then what the agent wrote.
 */
export function prBody(number, criteria, description) {
  return [
    `Closes #${number}`,
    `## Acceptance criteria from the ticket\n\n${criteriaList(criteria)}`,
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

/** The severities the quality gate in AGENTS.md knows, lowest last. */
export const SEVERITIES = Object.freeze(['High', 'Medium', 'Low']);

/**
 * The severity named by one of Qodo's group markers: a badge image such as
 * `img.shields.io/badge/Medium-634FD1` or a "View medium (2)" heading. A name
 * the gate doesn't know is kept as it is, and `blocks` treats it as High.
 */
function severityName(marker) {
  const known = SEVERITIES.find((name) => name.toLowerCase() === marker.toLowerCase());
  return known ?? marker;
}

/**
 * The comment with each finding's own text blanked out: its numbered title,
 * the quoted lines under it (description and agent prompt), `<pre>` blocks and
 * fenced code. Each character keeps its place, so an index in the result is
 * the same index in the comment. A badge or heading a finding quotes is not a
 * group marker.
 */
function outsideFindings(text) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  return text
    .replace(/<summary>\s*\d+\.\s+[\s\S]*?<\/summary>/g, blank)
    .replace(/<pre>[\s\S]*?<\/pre>/g, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/^>.*$/gm, blank);
}

/** Each place a severity group starts in a review comment, in order. */
function severityMarkers(comment) {
  const text = outsideFindings(comment);
  const markers = [
    ...[...text.matchAll(/img\.shields\.io\/badge\/([A-Za-z][A-Za-z ]*?)-[0-9A-Fa-f]{3,8}\b/g)].map((m) => ({ index: m.index, name: m[1] })),
    ...[...text.matchAll(/<summary>(?:\s*<[^>]+>)*\s*View ([A-Za-z][A-Za-z ]*?) \(\d+\)/g)].map((m) => ({ index: m.index, name: m[1] })),
    // The "Resolved findings" section ends the last severity group.
    ...[...text.matchAll(/<summary>(?:\s*<[^>]+>)*\s*Resolved findings/g)].map((m) => ({ index: m.index, name: null })),
  ];
  return markers.sort((a, b) => a.index - b.index);
}

/** A status label after a finding's title, the whole label. */
const STATUS_LABEL = /^\W*(?:New|Resolved|Dismissed|Outdated)$/u;
/** The status labels that say a finding no longer needs action. */
const CLOSED_LABEL = /^\W*(?:Resolved|Dismissed|Outdated)$/u;
/** A type label, the whole label: "🐞 Bug", "📘 Rule violation", "📎 Requirement gap". */
const TYPE_LABEL = /^\W*(?:Bug|Rule violation|Requirement gap)s?$/iu;
/** One `<code>` element that holds no other one. */
const CODE = /<code>((?:(?!<\/?code>)[\s\S])*)<\/code>/g;

/**
 * Split a finding's summary line into its title and the labels after it. The
 * labels are the `<code>` elements at the end of the line, from the first one
 * that names a type or a status. Inline code in the title stays in the title.
 */
function titleAndLabels(summary) {
  const trailing = /(?:\s*<code>(?:(?!<\/?code>)[\s\S])*<\/code>)+\s*$/.exec(summary);
  if (!trailing) return { title: summary, labels: [] };
  const codes = [...trailing[0].matchAll(CODE)];
  const known = codes.findIndex((m) => STATUS_LABEL.test(plainText(m[1])) || TYPE_LABEL.test(plainText(m[1])));
  const first = known === -1 ? 0 : known;
  return {
    title: summary.slice(0, trailing.index + codes[first].index),
    labels: codes.slice(first).map((m) => plainText(m[1])),
  };
}

/**
 * The files a finding is about: the paths in its agent prompt's "Fix Focus
 * Areas" list, or else the files its links on GitHub point at.
 */
function filesOf(prompt, section) {
  const focus = /## Fix Focus Areas\n([\s\S]*?)(?=\n## |$)/.exec(prompt);
  const listed = focus ? [...focus[1].matchAll(/^\s*-\s+(\S+?)(?:\[[^\]]*\])?\s*$/gm)].map((m) => m[1]) : [];
  const linked = [...section.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[0-9a-f]{7,40}\/([^\s#?"'<>)]+)/g)].map((m) => m[1]);
  return [...new Set(listed.length ? listed : linked)];
}

/**
 * Read one of Qodo's "Code Review" comments: the commit it reviewed and its
 * numbered findings. Null when the comment is something else, for example
 * Qodo's summary of the pull request.
 *
 * A finding's severity is the group it is listed under ("High", "Medium",
 * "Low"), or null when no group comes before it or it is listed under
 * "Resolved findings". A badge or heading quoted inside a finding's own text
 * doesn't start a group. Its kind is its type label, for example "🐞 Bug" or
 * "📘 Rule violation". Its files are the paths its agent prompt names.
 * @param {string} body
 * @returns {{ commit: string | null, findings: Array<{ number: number, title: string, kind: string, severity: string | null, resolved: boolean, description: string, prompt: string, files: string[] }> } | null}
 */
export function parseQodoReview(body) {
  const text = String(body ?? '');
  if (!/^\s*<h3>Code Review by Qodo<\/h3>/.test(text)) return null;

  const commits = [...text.matchAll(/<!--\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{40})\s*-->/g)];
  const commit = commits.length ? commits[commits.length - 1][1] : null;

  const markers = severityMarkers(text);
  const heads = [...text.matchAll(/<summary>\s*(\d+)\.\s+([\s\S]*?)<\/summary>/g)];
  const findings = heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const section = unquote(text.slice(head.index + head[0].length, end));
    const { title, labels } = titleAndLabels(head[2]);
    const group = markers.filter((marker) => marker.index < head.index).pop();
    const description = /<summary>Description<\/summary>[\s\S]*?<pre>([\s\S]*?)<\/pre>/.exec(section);
    const prompt = /<summary>Agent prompt<\/summary>[\s\S]*?```\n([\s\S]*?)\n```/.exec(section);
    const promptText = prompt ? prompt[1].trim() : '';
    return {
      number: Number(head[1]),
      title: plainText(title),
      kind: labels.find((label) => TYPE_LABEL.test(label)) ?? labels.find((label) => !STATUS_LABEL.test(label)) ?? '',
      severity: group?.name ? severityName(group.name) : null,
      resolved: /^\s*<s>/.test(head[2]) || labels.some((label) => CLOSED_LABEL.test(label)),
      description: description ? plainText(description[1]) : '',
      prompt: promptText,
      files: filesOf(promptText, section),
    };
  });
  return { commit, findings };
}

/**
 * Whether an open finding holds a task back under the quality gate in
 * AGENTS.md: High and Medium do, Low doesn't. A finding whose severity the
 * runner can't read counts as High.
 * @param {{ severity: string | null }} finding
 */
export function blocks(finding) {
  return finding.severity !== 'Low';
}

/** The arguments for the qodo command that reads the pull request's review run. */
export function qodoRunArgs(prUrl) {
  return ['read', 'pr-review-session', 'findings', '--pr-url', prUrl, '--json'];
}

/** The longest qodo error the runner keeps for its log and its stop reason. */
const QODO_ERROR_CHARS = 300;

function shorten(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > QODO_ERROR_CHARS ? `${line.slice(0, QODO_ERROR_CHARS - 1)}…` : line;
}

/**
 * The review_session statuses Qodo documents as ended without completing.
 * The list is the one in Qodo's Review Resolver skill
 * (.claude/skills/qodo-review-resolver/SKILL.md, "Read the session state
 * FIRST"); `qodo help` and the qodo read help don't list session statuses.
 * "started" and any status not on this list keep the runner waiting.
 */
export const ENDED_STATUSES = ['failed', 'aborted', 'skipped', 'superseded'];

/**
 * Whether Qodo's review run on the head is complete, from one qodo read of
 * the pull request. The run counts as complete only when `review_session`
 * names the head, its status is "completed" and `review_complete` is true.
 * When the session names the head and its status is in ENDED_STATUSES,
 * `ended` holds that status: the run is over and won't complete. Anything
 * else is not complete yet: no session, another commit, another status or a
 * truncated read. A failed command or output that is not JSON is not
 * complete either, and `error` holds what qodo said, shortened.
 * @param {{ code: number, stdout: string, stderr: string, timedOut?: boolean, message?: string }} result what the qodo command returned
 * @param {string} head the full SHA of the commit to look for
 * @returns {{ complete: boolean, error: string | null, ended: string | null }}
 */
export function reviewRunState(result, head) {
  const failed = (text) => ({ complete: false, error: shorten(text), ended: null });
  if (result.timedOut) return failed('qodo did not answer in time.');
  const output = String(result.stderr || result.stdout || result.message || '').trim();
  if (result.code !== 0) return failed(output || `qodo exited with code ${result.code}.`);
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return failed(`qodo did not print JSON: ${output}`);
  }
  if (!data || typeof data !== 'object') return failed(`qodo did not print a JSON object: ${output}`);
  if (data.error) return failed(JSON.stringify(data.error));
  if (data.qar_operation_result_truncated === true) return { complete: false, error: null, ended: null };
  const session = data.review_session;
  const onHead = Boolean(session) && session.commit_sha === head;
  const complete = onHead && session.status === 'completed' && session.review_complete === true;
  const ended = onHead && ENDED_STATUSES.includes(session.status) ? session.status : null;
  return { complete, error: null, ended };
}

/**
 * The run state the runner hands nextStep after one more qodo read: this
 * read's answer, with the last qodo error of the wait kept when this read
 * had none. A failed read followed by reads that work but show the run still
 * going leaves that error in the stop reason. `ended` comes from this read
 * only.
 * @param {{ complete: boolean, error: string | null, ended?: string | null } | null} previous the state after the read before, null on the first read
 * @param {{ complete: boolean, error: string | null, ended?: string | null }} current from reviewRunState
 */
export function carryRunError(previous, current) {
  return { complete: current.complete, error: current.error ?? previous?.error ?? null, ended: current.ended ?? null };
}

/**
 * How the runner calls qodo on each poll: the command, its arguments and a
 * timeout of LIMITS.qodoMs, far shorter than the default for other commands.
 * @param {string} command the qodo command, `qodo` unless FACTORY_QODO names another
 * @param {string} prUrl
 */
export function qodoCall(command, prUrl, limits = LIMITS) {
  return { command, args: qodoRunArgs(prUrl), options: { timeout: limits.qodoMs } };
}

/**
 * One poll of the wait for CI and Qodo's review, after the runner has read
 * CI, asked qodo about the review run and then read the comments.
 * @param {{ previous: { complete: boolean, error: string | null, ended?: string | null } | null, lastLogged: string | null, result: object, comments: object[], head: string, ci: 'pending' | 'passed' | 'failed', round: number, waitedMs: number }} poll
 *   previous is the run state after the poll before, lastLogged the qodo error the runner logged last
 * @returns {{ run: { complete: boolean, error: string | null, ended: string | null }, review: object | null, next: { step: string, reason?: string }, logError: string | null, lastLogged: string | null }}
 *   logError is a qodo error to log now: one that differs from the poll before's
 */
export function reviewPoll({ previous, lastLogged, result, comments, head, ci, round, waitedMs }, limits = LIMITS) {
  const read = reviewRunState(result, head);
  const run = carryRunError(previous, read);
  const review = reviewFor(comments, head, run);
  return {
    run,
    review,
    next: nextStep({ ci, review, run, round, waitedMs }, limits),
    logError: read.error && read.error !== lastLogged ? read.error : null,
    lastLogged: read.error,
  };
}

/**
 * The review the runner counts for the head: Qodo's review comment for it,
 * once Qodo reports the review run on the head as complete. Null before
 * then, even when the comment already names the head, because Qodo edits
 * that comment while the run is going.
 * @param {Array<{ body: string, user?: { login: string, type?: string } }>} comments
 * @param {string} head
 * @param {{ complete: boolean }} run from reviewRunState
 */
export function reviewFor(comments, head, run) {
  return run.complete ? reviewOf(comments, head) : null;
}

/**
 * Qodo's review of one commit, from the pull request's comments. Null while
 * the newest review comment is still for an older commit. It doesn't say
 * whether Qodo's review run on the commit is complete: reviewFor asks that
 * first. A comment only counts when
 * the Qodo app wrote it. `open` is each finding that still needs action,
 * `blocking` the open ones the gate says the agent fixes and `low` the open
 * ones that come to me.
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
  const open = found.findings.filter((finding) => !finding.resolved);
  return { ...found, open, blocking: open.filter(blocks), low: open.filter((finding) => !blocks(finding)) };
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
 * What the runner does next with an open pull request. Only the findings the
 * quality gate blocks on start a fix round or stop the run. Low ones don't.
 * The review is null until Qodo's review run on the head is complete and
 * its comment names the head (reviewFor), and the runner waits until then.
 * A run on the head that ended without completing stops the wait at once.
 * @param {{ ci: 'pending' | 'passed' | 'failed', review: { blocking: unknown[] } | null, run?: { complete: boolean, error: string | null, ended?: string | null }, round: number, waitedMs: number }} state
 *   run is the last reviewRunState, round is the number of fix rounds already used
 * @returns {{ step: 'wait' | 'fix' | 'review' | 'help', reason?: string }}
 */
export function nextStep({ ci, review, run, round, waitedMs }, limits = LIMITS) {
  if (ci === 'failed') return { step: 'help', reason: 'CI failed on the pull request.' };
  if (run?.ended) {
    return { step: 'help', reason: `Qodo's review run on the newest commit ended as "${run.ended}" without completing.` };
  }
  if (ci === 'pending' || !review) {
    if (waitedMs >= limits.reviewWaitMs) {
      const minutes = Math.round(limits.reviewWaitMs / 60000);
      let missing = "Qodo's review comment did not name the newest commit";
      if (ci === 'pending') {
        missing = 'CI did not finish';
      } else if (!run?.complete) {
        missing = "Qodo's review run on the newest commit did not complete";
      }
      // The last qodo error goes in whichever reason comes first, while the run isn't complete.
      const after = run && !run.complete && run.error ? ` The last qodo error: ${run.error}` : '';
      return { step: 'help', reason: `${missing} within ${minutes} minutes.${after}` };
    }
    return { step: 'wait' };
  }
  if (review.blocking.length === 0) return { step: 'review' };
  if (round >= limits.fixRounds) {
    const count = review.blocking.length;
    return {
      step: 'help',
      reason: `${count} High or Medium Qodo ${count === 1 ? 'finding is' : 'findings are'} still open after ${limits.fixRounds} fix rounds.`,
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
 * @param {{ number: number, repo: string, branch: string, notes: string, criteria?: string[], check?: string, output?: string, pr?: number }} run
 */
export function promptValues(file, run) {
  const base = { number: run.number, branch: run.branch, notes: run.notes };
  if (file === 'build.md') {
    // ticketProblems lets no ticket start without criteria, so an empty list here is a mistake in the runner.
    if (!run.criteria?.length) throw new Error('The runner has no acceptance criteria for the build prompt.');
    return { ...base, repo: run.repo, criteria: criteriaList(run.criteria) };
  }
  if (file === 'failed-check.md') return { ...base, check: run.check, output: run.output };
  if (file === 'fix.md') return { ...base, pr: run.pr };
  throw new Error(`The runner has no prompt file named "${file}".`);
}

/** The names a prompt file asks for, each one once. */
export function promptPlaces(template) {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))];
}

/** A finding's labels as one bracket: its severity and its type. */
function labelsOf(finding) {
  const labels = [finding.severity, finding.kind].filter(Boolean).join(', ');
  return labels ? ` (${labels})` : '';
}

/** Open findings as the text the agent gets in a fix round. */
export function findingsText(findings) {
  return findings
    .map((finding) =>
      [
        `## ${finding.number}. ${finding.title}${labelsOf(finding)}`,
        finding.description,
        finding.prompt ? `Qodo's suggested prompt:\n\n${finding.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n');
}

/**
 * The text the agent gets in a fix round: the review's High and Medium
 * findings and none of its Low ones.
 * @param {{ blocking: Array<{ number: number, title: string, kind: string, severity: string | null, description: string, prompt: string }> }} review
 */
export function fixRoundText(review) {
  return findingsText(review.blocking);
}

/**
 * The part of the runner's last comment on a ticket that lists the open Low
 * findings for me, each with its title, type and file. Empty when there are
 * none.
 * @param {Array<{ number: number, title: string, kind: string, severity: string | null, files?: string[] }>} findings
 */
export function lowFindingsText(findings) {
  if (findings.length === 0) return '';
  const lines = findings.map((finding) => {
    const files = finding.files?.length ? finding.files.map((file) => `\`${file}\``).join(', ') : 'not named in the review';
    return `- ${finding.number}. ${finding.title}${labelsOf(finding)}. File: ${files}`;
  });
  return `Low findings for you. The agent left this code as it is:\n\n${lines.join('\n')}`;
}

/**
 * The runner's comment on a ticket when the run ends with `agent-review`:
 * the pull request, the checks, the High and Medium findings it fixed, the
 * fix rounds used, then the open Low findings for me.
 * @param {{ pr: number, head: string, found: number, round: number, low: Array<{ number: number, title: string, kind: string, severity: string | null, files?: string[] }> }} run
 */
export function readyComment({ pr, head, found, round, low }, limits = LIMITS) {
  const findings =
    found === 0
      ? 'Qodo had no High or Medium findings.'
      : `Qodo raised ${found} High or Medium ${found === 1 ? 'finding' : 'findings'} and none are open.`;
  const ready = `Pull request #${pr} is ready for you. \`npm test\`, \`npm run check\` and CI pass on ${head.slice(0, 7)}. ${findings} Fix rounds used: ${round} of ${limits.fixRounds}. It is not merged.`;
  return [ready, lowFindingsText(low)].filter(Boolean).join('\n\n');
}
