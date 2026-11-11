#!/usr/bin/env node
/**
 * One run of the factory: take the lowest-numbered ticket with the
 * ready-for-agent label, start the coding agent on it, open the pull
 * request, wait for CI and Qodo's review, and let the agent fix what the
 * review found. docs/factory.md describes the setup and the limits.
 *
 * Usage: node factory/tick.js [--dry-run]
 *   --dry-run   say which ticket the run would take and change nothing
 *
 * Exit code 0: the run finished, with or without a ticket. 1: it stopped on
 * an error it did not expect. 2: it could not start.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_TOOLS,
  LABELS,
  LIMITS,
  branchFor,
  candidates,
  ciState,
  fillPrompt,
  findingsText,
  guardedFiles,
  labelledBy,
  lockIsStale,
  nextStep,
  reviewOf,
  ticketProblems,
} from './decisions.js';

const FACTORY = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(FACTORY);
const HOME = process.env.FACTORY_HOME || join(homedir(), '.agent-pfp-factory');
const CLAUDE = process.env.FACTORY_CLAUDE || 'claude';
const LOCK = join(HOME, 'lock');
/** The agent leaves its notes for the runner here, inside the worktree. Git ignores the folder. */
const NOTES = '.factory-run';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let logFile = join(HOME, 'logs', 'ticks.log');

async function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `${line}\n`);
}

/** Run a command and give back its exit code and output. It never throws for a failed command. */
function run(command, args, { cwd = REPO_DIR, timeout = 5 * 60 * 1000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error?.killed);
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr, timedOut });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Run a command that has to work. A failure ends the run. */
async function must(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  return result.stdout;
}

async function ghJson(args, options) {
  return JSON.parse(await must('gh', args, options));
}

/** Each page of a list from the GitHub API, as one array. */
async function ghPages(path) {
  return (await ghJson(['api', '--paginate', '--slurp', path])).flat();
}

async function takeLock() {
  await mkdir(HOME, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(LOCK);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const { mtimeMs } = await stat(LOCK);
      if (!lockIsStale(mtimeMs, Date.now())) return false;
      await rm(LOCK, { recursive: true, force: true });
    }
  }
  return false;
}

async function setLabel(repo, number, from, to) {
  await must('gh', ['issue', 'edit', String(number), '--repo', repo, '--remove-label', from, '--add-label', to]);
}

async function comment(repo, kind, number, body) {
  await must('gh', [kind, 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body });
}

/** The first ticket the owner opened and labelled, or null. */
async function chooseTicket(repo, owner) {
  const issues = await ghJson([
    'issue', 'list', '--repo', repo, '--state', 'open', '--label', LABELS.ready,
    '--limit', '100', '--json', 'number,title,body,author,labels,state',
  ]);
  const { tickets, skipped } = candidates(issues, owner);
  for (const { number, reason } of skipped) await log(`Skipped #${number}: ${reason}.`);
  for (const ticket of tickets) {
    const events = await ghPages(`repos/${repo}/issues/${ticket.number}/events`);
    const who = labelledBy(events, LABELS.ready);
    if (who === owner) return ticket;
    await log(`Skipped #${ticket.number}: ${who ?? 'nobody on record'} added the label, not ${owner}.`);
  }
  return null;
}

/** Start the coding agent once in the worktree and wait for it. */
async function callAgent(worktree, prompt, session) {
  const args = ['-p', '--output-format', 'json', '--allowedTools', ...AGENT_TOOLS];
  if (process.env.FACTORY_MODEL) args.push('--model', process.env.FACTORY_MODEL);
  if (session) args.push('--resume', session);
  const started = Date.now();
  const result = await run(CLAUDE, args, { cwd: worktree, timeout: LIMITS.agentMs, input: prompt });
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  if (result.timedOut) return { ok: false, reason: `The agent was still working after ${LIMITS.agentMs / 60000} minutes.` };
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: `The agent call failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}` };
  }
  const denied = (report.permission_denials ?? []).length;
  await log(`Agent finished in ${minutes} min, ${report.num_turns} turns, ${denied} tool calls refused.`);
  if (report.is_error) return { ok: false, reason: `The agent stopped with an error: ${String(report.result).slice(0, 500)}` };
  return { ok: true, session: report.session_id };
}

async function readNote(worktree, name) {
  try {
    return (await readFile(join(worktree, NOTES, name), 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * The runner's own look at what the agent left: a commit, a clean tree,
 * nothing in a guarded folder, and both checks passing. Returns the reason
 * it is not good, or null.
 */
async function inspect(worktree, before) {
  const head = (await must('git', ['rev-parse', 'HEAD'], { cwd: worktree })).trim();
  if (head === before) return { problem: 'The agent finished without a commit.' };
  const dirty = (await must('git', ['status', '--porcelain'], { cwd: worktree })).trim();
  if (dirty) return { problem: 'The agent left changes it did not commit.' };
  const files = (await must('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: worktree })).split('\n').filter(Boolean);
  const guarded = guardedFiles(files);
  if (guarded.length) return { problem: `The change touches files the agent may not change: ${guarded.join(', ')}.` };
  for (const script of [['test'], ['run', 'check']]) {
    const result = await run('npm', script, { cwd: worktree, timeout: 10 * 60 * 1000 });
    const name = `npm ${script.join(' ')}`;
    if (result.code !== 0) {
      await log(`${name} failed.`);
      return { problem: `\`${name}\` failed.`, output: (result.stdout + result.stderr).slice(-6000), failedCheck: name };
    }
    const tests = /^(?:#|ℹ) pass (\d+)$/m.exec(result.stdout);
    await log(`${name} passed${tests ? ` (${tests[1]} tests)` : ''}.`);
  }
  return { problem: null, head };
}

async function waitForReview(repo, pr, head, round) {
  const started = Date.now();
  for (;;) {
    const runs = await ghJson(['api', `repos/${repo}/commits/${head}/check-runs`]);
    const ci = ciState(runs.check_runs.filter((check) => check.app?.slug === 'github-actions'));
    const comments = await ghPages(`repos/${repo}/issues/${pr}/comments`);
    const review = reviewOf(comments, head);
    const next = nextStep({ ci, review, round, waitedMs: Date.now() - started });
    if (next.step !== 'wait') {
      const waited = ((Date.now() - started) / 60000).toFixed(1);
      await log(`CI ${ci}, Qodo ${review ? `${review.findings.length} findings, ${review.open.length} open` : 'no review'} on ${head.slice(0, 7)} after ${waited} min.`);
      return { ...next, review };
    }
    await sleep(LIMITS.pollMs);
  }
}

async function work(repo, ticket) {
  const number = ticket.number;
  const branch = branchFor(ticket);
  const worktree = join(HOME, 'runs', `issue-${number}`);
  const prompts = join(FACTORY, 'prompts');
  let pr = null;
  let round = 0;
  let found = 0;

  const stop = async (reason) => {
    await log(`Stopped for help: ${reason}`);
    await setLabel(repo, number, LABELS.working, LABELS.help);
    const where = pr ? `Pull request #${pr} is open and not merged.` : 'No pull request was opened.';
    await comment(repo, 'issue', number, `The agent run stopped and needs you.\n\n${reason}\n\n${where} Fix rounds used: ${round} of ${LIMITS.fixRounds}.`);
  };

  await setLabel(repo, number, LABELS.ready, LABELS.working);
  await log(`Took #${number} "${ticket.title}", branch ${branch}.`);

  await must('git', ['fetch', '--quiet', 'origin', 'main']);
  const remote = (await must('git', ['ls-remote', '--heads', 'origin', branch])).trim();
  if (remote) return stop(`The branch \`${branch}\` is already on GitHub from an earlier run.`);
  await run('git', ['worktree', 'remove', '--force', worktree]);
  await run('git', ['branch', '-D', branch]);
  await must('git', ['worktree', 'add', '--quiet', '-b', branch, worktree, 'origin/main']);
  await must('npm', ['ci', '--silent'], { cwd: worktree });
  await mkdir(join(worktree, NOTES), { recursive: true });
  const base = (await must('git', ['rev-parse', 'HEAD'], { cwd: worktree })).trim();

  // Build. A failed check sends the agent back in, and that uses a fix round.
  const values = { number, repo, branch, notes: NOTES };
  let agent = await callAgent(worktree, fillPrompt(await readFile(join(prompts, 'build.md'), 'utf8'), values));
  if (!agent.ok) return stop(agent.reason);
  let state = await inspect(worktree, base);
  while (state.problem) {
    if (!state.failedCheck || round >= LIMITS.fixRounds) return stop(state.problem);
    round += 1;
    const prompt = fillPrompt(await readFile(join(prompts, 'failed-check.md'), 'utf8'), { ...values, check: state.failedCheck, output: state.output });
    agent = await callAgent(worktree, prompt, agent.session);
    if (!agent.ok) return stop(agent.reason);
    state = await inspect(worktree, base);
  }

  const description = await readNote(worktree, 'pr-body.md');
  if (!description) return stop(`The agent left no pull request description in ${NOTES}/pr-body.md.`);
  await must('git', ['push', '--quiet', '-u', 'origin', branch], { cwd: worktree });
  const url = (
    await must('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch, '--title', ticket.title, '--body-file', '-'], {
      cwd: worktree,
      input: `Closes #${number}\n\n${description}\n`,
    })
  ).trim();
  pr = Number(url.split('/').pop());
  await log(`Opened ${url}`);

  // Review, fix, review again.
  for (;;) {
    const next = await waitForReview(repo, pr, state.head, round);
    if (next.step === 'help') return stop(next.reason);
    if (next.step === 'review') break;
    round += 1;
    found += next.review.open.length;
    await log(`Fix round ${round} of ${LIMITS.fixRounds}: ${next.review.open.map((finding) => finding.title).join('; ')}`);
    await writeFile(join(worktree, NOTES, 'findings.md'), findingsText(next.review.open));
    await rm(join(worktree, NOTES, 'reply.md'), { force: true });
    const before = state.head;
    const prompt = fillPrompt(await readFile(join(prompts, 'fix.md'), 'utf8'), { ...values, pr });
    agent = await callAgent(worktree, prompt, agent.session);
    if (!agent.ok) return stop(agent.reason);
    state = await inspect(worktree, before);
    if (state.problem) return stop(state.problem);
    const reply = await readNote(worktree, 'reply.md');
    if (!reply) return stop(`The agent left no answer to the findings in ${NOTES}/reply.md.`);
    await must('git', ['push', '--quiet', 'origin', branch], { cwd: worktree });
    await comment(repo, 'pr', pr, reply);
    await log(`Pushed ${state.head.slice(0, 7)} and answered the findings on #${pr}.`);
  }

  await setLabel(repo, number, LABELS.working, LABELS.review);
  const findings = found === 0 ? 'Qodo had no findings.' : `Qodo raised ${found} ${found === 1 ? 'finding' : 'findings'} and none are open.`;
  await comment(repo, 'issue', number, `Pull request #${pr} is ready for you. \`npm test\`, \`npm run check\` and CI pass on ${state.head.slice(0, 7)}. ${findings} Fix rounds used: ${round} of ${LIMITS.fixRounds}. It is not merged.`);
  await log(`Done: #${pr} is ready for review.`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { nameWithOwner: repo, owner } = await ghJson(['repo', 'view', '--json', 'nameWithOwner,owner']);

  if (dryRun) {
    const ticket = await chooseTicket(repo, owner.login);
    await log(ticket ? `Dry run: would take #${ticket.number} "${ticket.title}" on branch ${branchFor(ticket)}.` : `No ticket has the ${LABELS.ready} label.`);
    return 0;
  }

  if (!(await takeLock())) {
    await log('Another run holds the lock.');
    return 0;
  }
  try {
    const ticket = await chooseTicket(repo, owner.login);
    if (!ticket) {
      await log(`No ticket has the ${LABELS.ready} label.`);
      return 0;
    }
    logFile = join(HOME, 'logs', `issue-${ticket.number}.log`);
    const problems = ticketProblems(ticket);
    if (problems.length) {
      await log(`#${ticket.number} can't start: ${problems.join(' ')}`);
      await setLabel(repo, ticket.number, LABELS.ready, LABELS.help);
      await comment(repo, 'issue', ticket.number, `The agent didn't start on this ticket.\n\n${problems.join('\n')}`);
      return 0;
    }
    try {
      await work(repo, ticket);
    } catch (error) {
      // The ticket must not sit on agent-working with nobody working on it.
      await log(`The run failed: ${error.message}`);
      await run('gh', ['issue', 'edit', String(ticket.number), '--repo', repo, '--remove-label', LABELS.working, '--add-label', LABELS.help]);
      await run('gh', ['issue', 'comment', String(ticket.number), '--repo', repo, '--body-file', '-'], {
        input: `The agent run stopped on an error in the runner and needs you.\n\n${error.message}`,
      });
      return 1;
    }
    return 0;
  } finally {
    await rm(LOCK, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  async (error) => {
    await log(`The run failed: ${error.message}`);
    process.exit(1);
  },
);
