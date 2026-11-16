#!/usr/bin/env node
/**
 * Keep the factory log: docs/factory-log.json holds one entry for each
 * merged pull request, and docs/factory-log.md is written from it.
 * docs/factory.md says when it runs.
 *
 * Usage:
 *   node factory/log.js add <pull request> [--day N] [--taste "text"] [--post <url>]
 *     reads the merged pull request from GitHub, CI and Qodo, puts its entry
 *     in the JSON file in place of an older one and writes the markdown again.
 *   node factory/log.js render
 *     only writes the markdown again from the JSON file.
 *
 * Exit code 0: done, or a pull request that only changes the log. 1: a
 * command failed. 2: the arguments are wrong or the pull request isn't merged.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { qodoCall } from './decisions.js';
import { addEntry, buildEntry, isLogOnly, parseArgs, renderCheckLine, renderLog } from './log-entry.js';

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const JSON_FILE = join(REPO_DIR, 'docs', 'factory-log.json');
const MD_FILE = join(REPO_DIR, 'docs', 'factory-log.md');
const QODO = process.env.FACTORY_QODO || 'qodo';
const USAGE = 'Usage: node factory/log.js add <pull request> [--day N] [--taste "text"] [--post <url>] | node factory/log.js render';

/** Run a command and give back its exit code and output. It never throws for a failed command. */
function run(command, args, { cwd = REPO_DIR, timeout = 2 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr, timedOut: Boolean(error?.killed), message: error?.message });
    });
  });
}

async function must(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.message || '').trim().slice(0, 2000)}`);
  }
  return result.stdout;
}

const ghJson = async (args) => JSON.parse(await must('gh', args));

async function readEntries() {
  try {
    return JSON.parse(await readFile(JSON_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function render(entries) {
  await writeFile(MD_FILE, renderLog(entries));
}

/** Qodo's findings on the pull request, for the severity of the resolved ones. Null when qodo can't be read. */
async function qodoFindings(url) {
  const call = qodoCall(QODO, url);
  const result = await run(call.command, call.args, call.options);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  } catch {
    return null;
  }
}

/** The render check line and CI's conclusion on the pull request's last commit. */
async function ciResult(repo, head) {
  const { workflow_runs: runs } = await ghJson(['api', `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`]);
  const ci = runs.filter((r) => r.name === 'CI' && r.status === 'completed').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!ci) return { renderCheck: null, ci: null };
  const log = await run('gh', ['run', 'view', String(ci.id), '--repo', repo, '--log']);
  return { renderCheck: log.code === 0 ? renderCheckLine(log.stdout) : null, ci: ci.conclusion };
}

async function add(options) {
  const { nameWithOwner: repo } = await ghJson(['repo', 'view', '--json', 'nameWithOwner']);
  const fields = 'number,url,mergedAt,mergeCommit,closingIssuesReferences,headRefOid,files';
  const pr = await ghJson(['pr', 'view', String(options.pr), '--repo', repo, '--json', fields]);
  if (!pr.mergedAt) {
    console.error(`#${pr.number} is not merged.`);
    return 2;
  }
  if (isLogOnly(pr.files.map((file) => file.path))) {
    console.log(`#${pr.number} only changes the log, so it gets no entry.`);
    return 0;
  }
  const comments = (await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr.number}/comments?per_page=100`])).flat();
  const qodo = await qodoFindings(pr.url);
  // CI on the pull request's last commit, or else on the merge.
  let { renderCheck, ci } = await ciResult(repo, pr.headRefOid);
  if (!ci) ({ renderCheck, ci } = await ciResult(repo, pr.mergeCommit.oid));
  const entry = buildEntry({ pr, comments, qodo, renderCheck, ci, day: options.day, taste: options.taste, post: options.post });
  const entries = addEntry(await readEntries(), entry);
  await writeFile(JSON_FILE, `${JSON.stringify(entries, null, 2)}\n`);
  await render(entries);
  console.log(`#${pr.number}: ${entry.caught.length} findings fixed, render check "${entry.renderCheck}".`);
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.command === 'render') {
    await render(await readEntries());
    return 0;
  }
  if (options.command !== 'add' || !Number.isInteger(options.pr) || options.pr <= 0) {
    console.error(USAGE);
    return 2;
  }
  return add(options);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
