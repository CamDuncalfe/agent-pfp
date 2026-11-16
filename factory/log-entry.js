/**
 * The decisions behind the factory log in docs/factory-log.md: what one
 * entry holds for a merged pull request, and how the entries are written as
 * markdown. factory/log.js reads GitHub, CI and Qodo and calls these. Nothing
 * here uses the network.
 */
import { QODO_BOT, parseQodoReview } from './decisions.js';

/** The files the log itself is kept in. A pull request that only changes these is not logged. */
export const LOG_FILES = Object.freeze(['docs/factory-log.json', 'docs/factory-log.md']);

/** Qodo's `action_level` for each severity, as AGENTS.md lists them. */
const LEVELS = Object.freeze({ action_required: 'High', remediation_recommended: 'Medium', informational: 'Low' });

/** Whether a pull request changes only the log files. */
export function isLogOnly(files) {
  return files.length > 0 && files.every((file) => LOG_FILES.includes(file));
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The severity of each finding title in a `qodo read pr-review-session
 * findings --json` result. A title listed twice with two severities has
 * none.
 * @param {{ findings?: Array<{ title: string, action_level: string }> } | null} qodo
 * @returns {Map<string, string | null>}
 */
export function severities(qodo) {
  const map = new Map();
  for (const finding of qodo?.findings ?? []) {
    const title = squash(finding.title);
    const level = LEVELS[finding.action_level] ?? null;
    map.set(title, map.has(title) && map.get(title) !== level ? null : level);
  }
  return map;
}

/**
 * The newest of Qodo's review comments on a pull request, read with
 * parseQodoReview, or null when there is none.
 */
export function lastReview(comments) {
  let found = null;
  for (const comment of comments) {
    if (comment.user?.login !== QODO_BOT) continue;
    found = parseQodoReview(comment.body) ?? found;
  }
  return found;
}

/**
 * The result of `npm run check` in a CI log from `gh run view --log`: each
 * style's "Combinations checked" line and the last "Render check" line.
 * Null when the log has no render check in it.
 * @param {string} log
 * @returns {string | null}
 */
export function renderCheckLine(log) {
  // A line of `gh run view --log` is "job<TAB>step<TAB>timestamp text".
  const lines = String(log ?? '')
    .split(/\r?\n/)
    .map((line) => line.split('\t').pop().replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  const start = lines.findIndex((line) => /^> \S+ check$/.test(line));
  if (start === -1) return null;
  const parts = [];
  let style = null;
  let verdict = null;
  for (const line of lines.slice(start + 1)) {
    if (/^Post job cleanup|^##\[/.test(line)) break;
    const named = /^Style: (.+)$/.exec(line);
    if (named) style = named[1];
    const combinations = /^Combinations checked: (.+)$/.exec(line);
    if (combinations) parts.push(style ? `${style}: ${combinations[1]}` : combinations[1]);
    if (/^Render check (passed|failed)/.test(line)) verdict = line.replace(/\.$/, '');
  }
  if (!verdict && parts.length === 0) return null;
  return [...parts, verdict].filter(Boolean).join('; ');
}

/**
 * The CI run a pull request shows on its last commit, from \`gh pr view
 * --json statusCheckRollup\`: the newest finished check of the "CI"
 * workflow. Its id comes from the check's link to the run. Null when the
 * pull request shows no finished CI check. A run on the merge commit is not
 * on the pull request, so it never counts.
 * @param {Array<{ __typename?: string, workflowName?: string, status?: string, conclusion?: string, completedAt?: string, detailsUrl?: string }> | undefined} rollup
 * @returns {{ id: string, conclusion: string } | null}
 */
export function ciRunOf(rollup) {
  const runs = (rollup ?? [])
    .filter((check) => check.workflowName === 'CI' && check.status === 'COMPLETED')
    .map((check) => ({ check, id: /\/actions\/runs\/(\d+)/.exec(check.detailsUrl ?? '')?.[1] }))
    .filter(({ id }) => id)
    .sort((a, b) => String(b.check.completedAt).localeCompare(String(a.check.completedAt)));
  if (runs.length === 0) return null;
  return { id: runs[0].id, conclusion: String(runs[0].check.conclusion ?? '').toLowerCase() || 'unknown' };
}

/**
 * One log entry for a merged pull request.
 * @param {object} input
 * @param {{ number: number, url: string, mergedAt: string, mergeCommit: { oid: string }, closingIssuesReferences?: Array<{ number: number }> }} input.pr
 *   from `gh pr view --json number,url,mergedAt,mergeCommit,closingIssuesReferences`
 * @param {Array<{ user: { login: string }, body: string }>} input.comments the pull request's comments
 * @param {object | null} input.qodo the `qodo read pr-review-session findings --json` result, for the severity of resolved findings
 * @param {string | null} input.renderCheck renderCheckLine of the CI log, or null
 * @param {string | null} input.ci CI's conclusion on the pull request's last commit, used when the log has no render check
 * @param {number | null} [input.day] the hackathon challenge day
 * @param {string | null} [input.taste] the decision that went to Cam, or null for none
 * @param {string | null} [input.post] the link to the day's post
 */
export function buildEntry({ pr, comments, qodo, renderCheck, ci, day = null, taste = null, post = null }) {
  const review = lastReview(comments);
  const levels = severities(qodo);
  // The log keeps the findings Qodo marks resolved and names a resolving commit for.
  const caught = (review?.findings ?? [])
    .filter((finding) => finding.resolved && finding.fixedIn)
    .map((finding) => ({
      severity: finding.severity ?? levels.get(squash(finding.title)) ?? 'unknown',
      title: finding.title,
      fixedIn: finding.fixedIn,
    }));
  return {
    pr: pr.number,
    url: pr.url,
    mergedAt: pr.mergedAt,
    merge: pr.mergeCommit.oid,
    tickets: (pr.closingIssuesReferences ?? []).map((issue) => issue.number),
    day: day ?? null,
    review: review ? (review.findings.length === 0 ? 'nothing' : 'findings') : 'none',
    caught,
    renderCheck: renderCheck ?? (ci ? `CI ${ci}` : 'unknown'),
    taste: taste || null,
    post: post || null,
  };
}

/**
 * The command line of factory/log.js: the command, the pull request number
 * and the flags after it.
 */
export function parseArgs(argv) {
  const [command, number, ...rest] = argv;
  const options = { command, pr: Number(number), day: null, taste: null, post: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === '--day') options.day = Number(value);
    else if (flag === '--taste') options.taste = value;
    else if (flag === '--post') options.post = value;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (options.day !== null && !(Number.isInteger(options.day) && options.day > 0)) throw new Error('--day needs a day number.');
  return options;
}

/**
 * The day, taste call and post for a pull request's entry: each flag that
 * was given, and else what its entry already holds, so adding a row again
 * without the flags keeps them.
 * @param {Array<{ pr: number, day: number | null, taste: string | null, post: string | null }>} entries
 * @param {{ pr: number, day: number | null, taste: string | null, post: string | null }} options from parseArgs
 */
export function detailsFor(entries, options) {
  const old = entries.find((entry) => entry.pr === options.pr) ?? {};
  return {
    day: options.day ?? old.day ?? null,
    taste: options.taste ?? old.taste ?? null,
    post: options.post ?? old.post ?? null,
  };
}

/**
 * What \`node factory/log.js add\` does with a pull request it read: the
 * exit code, the line it prints, and the entries to write, or null when it
 * writes nothing. A pull request that isn't merged ends with 2, one that
 * only changes the log gets no entry, and any other gets its entry in place
 * of an older one.
 * @param {{ entries: object[], pr: { number: number, mergedAt: string | null, files: Array<{ path: string }> }, options: object, comments?: object[], qodo?: object | null, ci?: { renderCheck: string | null, ci: string | null } }} input
 * @returns {{ code: number, message: string, entries: object[] | null }}
 */
export function addResult({ entries, pr, options, comments = [], qodo = null, ci = { renderCheck: null, ci: null } }) {
  if (!pr.mergedAt) return { code: 2, message: `#${pr.number} is not merged.`, entries: null };
  if (isLogOnly(pr.files.map((file) => file.path))) {
    return { code: 0, message: `#${pr.number} only changes the log, so it gets no entry.`, entries: null };
  }
  const entry = buildEntry({ pr, comments, qodo, renderCheck: ci.renderCheck, ci: ci.ci, ...detailsFor(entries, options) });
  return {
    code: 0,
    message: `#${pr.number}: ${entry.caught.length} findings fixed, render check "${entry.renderCheck}".`,
    entries: addEntry(entries, entry),
  };
}

/** Put an entry in the list, in place of an older one for the same pull request, oldest merge first. */
export function addEntry(entries, entry) {
  return [...entries.filter((old) => old.pr !== entry.pr), entry].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.pr - b.pr);
}

const cell = (text) => squash(text).replace(/\|/g, '\\|');
const repoOf = (url) => /^(https:\/\/github\.com\/[^/]+\/[^/]+)\//.exec(url)?.[1] ?? '';
const commitLink = (repo, sha) => `[\`${sha.slice(0, 7)}\`](${repo}/commit/${sha})`;

/** One row of the table. */
export function renderRow(entry) {
  const repo = repoOf(entry.url);
  const caught = { nothing: 'Nothing', none: 'unknown', findings: '' }[entry.review];
  const fixes = [...new Set(entry.caught.map((finding) => finding.fixedIn))];
  const cells = [
    entry.mergedAt.slice(0, 10),
    entry.day ?? '',
    entry.tickets.map((n) => `[#${n}](${repo}/issues/${n})`).join(', '),
    `[#${entry.pr}](${entry.url}) ${commitLink(repo, entry.merge)}`,
    entry.caught.length ? entry.caught.map((finding) => cell(`${finding.severity}: ${finding.title}`)).join('<br>') : caught,
    fixes.map((sha) => commitLink(repo, sha)).join(', '),
    cell(entry.renderCheck),
    cell(entry.taste ?? 'No'),
    entry.post ? `[post](${entry.post})` : '',
  ];
  return `|${cells.map((text) => (text === '' ? ' ' : ` ${text} `)).join('|')}|`;
}

/** The whole of docs/factory-log.md for these entries. */
export function renderLog(entries) {
  return `# Factory log

One row for each pull request merged into \`main\`, oldest first. "Qodo caught" lists the findings from Qodo's review comment that a commit in the pull request fixed, with their severity, and "Fixed in" names those commits. "Render check" is what \`npm run check\` printed in CI on the pull request's last commit. A pull request that only changes this log has no row.

The rows are kept in [factory-log.json](factory-log.json), and this page is written from it. After each merge, \`node factory/log.js add <pull request>\` adds that pull request's row. [factory.md](factory.md#the-factory-log) says how.

| Date | Day | Ticket | Pull request | Qodo caught | Fixed in | Render check | Taste call to Cam | Post |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${entries.map(renderRow).join('\n')}
`;
}
