#!/usr/bin/env node
/**
 * One run of the factory: take the lowest-numbered ticket with the
 * ready-for-agent label, start the coding agent on it, open the pull
 * request, wait for CI and Qodo's review, and let the agent fix what the
 * review found. docs/factory.md describes the setup and the limits.
 *
 * Usage: node factory/tick.js [--dry-run]
 *   --dry-run   print which ticket the run would take. It changes nothing
 *               on GitHub and writes no file.
 *
 * Exit code 0: the run finished, with or without a ticket. 1: it stopped on
 * an error it did not expect. 2: it could not start.
 */
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LABELS,
  LIMITS,
  acceptanceCriteria,
  agentArgs,
  branchFor,
  candidates,
  ciState,
  fillPrompt,
  fixRoundText,
  readyComment,
  guardedFiles,
  labelledBy,
  lockCommand,
  prBody,
  promptValues,
  qodoCall,
  reviewPoll,
  ticketProblems,
} from './decisions.js';

const FACTORY = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(FACTORY);
const HOME = process.env.FACTORY_HOME || join(homedir(), '.agent-pfp-factory');
const CLAUDE = process.env.FACTORY_CLAUDE || 'claude';
const QODO = process.env.FACTORY_QODO || 'qodo';
const LOCK = join(HOME, 'tick.lock');
/** Set on the second start of this script, the one that runs while the lock is held. */
const HOLDING_LOCK = '--holding-lock';
const DRY_RUN = process.argv.includes('--dry-run');
/** The agent leaves its notes for the runner here, inside the worktree. Git ignores the folder. */
const NOTES = '.factory-run';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let logFile = join(HOME, 'logs', 'ticks.log');

/** Print a line and keep it in the log file. A dry run only prints. */
async function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (DRY_RUN) return;
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
        // message says why a command that printed nothing failed, such as one that is not installed.
        resolve({ code, stdout, stderr, timedOut, message: error?.message });
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

/**
 * Start this script again under the lock and wait for it. The operating
 * system holds the lock for as long as that process runs.
 * @returns {Promise<number>} the exit code of the locked run, or 0 when another run has the lock
 */
async function runLocked() {
  await mkdir(HOME, { recursive: true });
  const { command, args, heldExit } = lockCommand(process.platform, LOCK);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, [...args, process.execPath, fileURLToPath(import.meta.url), HOLDING_LOCK], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== heldExit) return code;
  await log('Another run holds the lock.');
  return 0;
}

async function setLabel(repo, number, from, to) {
  await must('gh', ['issue', 'edit', String(number), '--repo', repo, '--remove-label', from, '--add-label', to]);
}

async function comment(repo, kind, number, body) {
  await must('gh', [kind, 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body });
}

/** The first ticket the owner opened and labelled, or null. */
async function chooseTicket(repo, owner) {
  const issues = await ghPages(`repos/${repo}/issues?state=open&labels=${LABELS.ready}&per_page=100`);
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
  const args = agentArgs({ model: process.env.FACTORY_MODEL, session });
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

/**
 * Wait for CI and for Qodo's review of the head. Each poll asks qodo whether
 * the review run on the head is complete before it reads the comment, so a
 * comment Qodo is still editing never counts. A failed qodo read is logged
 * and counts as not complete, and the last qodo error of the wait stays in
 * the run state for the stop reason. A run on the head that Qodo reports as
 * ended without completing stops the wait at once.
 */
async function waitForReview(repo, pr, url, head, round) {
  const started = Date.now();
  const call = qodoCall(QODO, url);
  let lastLogged = null;
  let reviewRun = null;
  for (;;) {
    const pages = await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/commits/${head}/check-runs?per_page=100`]);
    const ci = ciState(pages.flatMap((page) => page.check_runs).filter((check) => check.app?.slug === 'github-actions'));
    const result = await run(call.command, call.args, call.options);
    const comments = await ghPages(`repos/${repo}/issues/${pr}/comments`);
    const poll = reviewPoll({ previous: reviewRun, lastLogged, result, comments, head, ci, round, waitedMs: Date.now() - started });
    if (poll.logError) await log(`The qodo read failed: ${poll.logError}`);
    ({ lastLogged, run: reviewRun } = poll);
    const { review, next } = poll;
    if (next.step !== 'wait') {
      const waited = ((Date.now() - started) / 60000).toFixed(1);
      const qodo = review
        ? `${review.findings.length} findings, ${review.blocking.length} High or Medium open, ${review.low.length} Low open`
        : `no review, run ${reviewRun.ended ? `ended as ${reviewRun.ended}` : reviewRun.complete ? 'complete' : 'not complete'}`;
      await log(`CI ${ci}, Qodo ${qodo} on ${head.slice(0, 7)} after ${waited} min.`);
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
  // One list for the build prompt and the pull request description.
  const criteria = acceptanceCriteria(ticket.body);
  const ticketRun = { number, repo, branch, notes: NOTES, criteria };
  const promptFor = async (file, extra = {}) =>
    fillPrompt(await readFile(join(prompts, file), 'utf8'), promptValues(file, { ...ticketRun, ...extra }));
  let agent = await callAgent(worktree, await promptFor('build.md'));
  if (!agent.ok) return stop(agent.reason);
  let state = await inspect(worktree, base);
  while (state.problem) {
    if (!state.failedCheck || round >= LIMITS.fixRounds) return stop(state.problem);
    round += 1;
    const prompt = await promptFor('failed-check.md', { check: state.failedCheck, output: state.output });
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
      input: prBody(number, criteria, description),
    })
  ).trim();
  pr = Number(url.split('/').pop());
  await log(`Opened ${url}`);

  // Review, fix, review again, until the quality gate in AGENTS.md is met:
  // no High or Medium finding open on the newest commit.
  let low = [];
  for (;;) {
    const next = await waitForReview(repo, pr, url, state.head, round);
    if (next.step === 'help') return stop(next.reason);
    if (next.step === 'review') {
      low = next.review.low;
      break;
    }
    round += 1;
    found += next.review.blocking.length;
    await log(`Fix round ${round} of ${LIMITS.fixRounds}: ${next.review.blocking.map((finding) => finding.title).join('; ')}`);
    await writeFile(join(worktree, NOTES, 'findings.md'), fixRoundText(next.review));
    await rm(join(worktree, NOTES, 'reply.md'), { force: true });
    const before = state.head;
    agent = await callAgent(worktree, await promptFor('fix.md', { pr }), agent.session);
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
  await comment(repo, 'issue', number, readyComment({ pr, head: state.head, found, round, low }));
  await log(`Done: #${pr} is ready for review.`);
}

async function main() {
  const { nameWithOwner: repo, owner } = await ghJson(['repo', 'view', '--json', 'nameWithOwner,owner']);

  if (DRY_RUN) {
    const ticket = await chooseTicket(repo, owner.login);
    await log(ticket ? `Dry run: would take #${ticket.number} "${ticket.title}" on branch ${branchFor(ticket)}.` : `No ticket has the ${LABELS.ready} label.`);
    return 0;
  }
  if (!process.argv.includes(HOLDING_LOCK)) return runLocked();

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
}

main().then(
  (code) => process.exit(code),
  async (error) => {
    await log(`The run failed: ${error.message}`);
    process.exit(1);
  },
);
