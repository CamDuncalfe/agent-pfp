// Runs factory/tick.sh for real in a throwaway runner checkout, with a stub
// `gh` and a `git` wrapper that writes down every call. It checks the order
// from ticket #16: the pull waits for the lock, and the run is the code it
// just pulled.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { lockCommand } from '../factory/decisions.js';

const run = promisify(execFile);
const FACTORY = new URL('../factory/', import.meta.url);
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

async function git(cwd, ...args) {
  const { stdout } = await run('git', [...ID, ...args], { cwd });
  return stdout.trim();
}

/**
 * A bare "origin", a runner checkout on main, and a second checkout that
 * pushes one more commit to main. That commit renames the ready label, so a
 * run that prints the new name is running the pulled code.
 */
async function setUp() {
  const root = await mkdtemp(join(tmpdir(), 'factory-tick-'));
  const origin = join(root, 'origin.git');
  const runner = join(root, 'runner');
  const other = join(root, 'other');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const gitLog = join(root, 'git.log');

  await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  await run('git', ['clone', '--quiet', origin, runner]);
  await cp(FACTORY, join(runner, 'factory'), { recursive: true });
  await git(runner, 'add', '-A');
  await git(runner, 'commit', '--quiet', '-m', 'runner');
  await git(runner, 'push', '--quiet', 'origin', 'HEAD:main');
  await git(runner, 'branch', '--quiet', '--set-upstream-to=origin/main');

  await run('git', ['clone', '--quiet', origin, other]);
  const decisions = join(other, 'factory', 'decisions.js');
  const before = await readFile(decisions, 'utf8');
  const after = before.replace("ready: 'ready-for-agent'", "ready: 'ready-after-pull'");
  assert.notEqual(after, before);
  await writeFile(decisions, after);
  await git(other, 'commit', '--quiet', '-am', 'rename the ready label');
  await git(other, 'push', '--quiet', 'origin', 'HEAD:main');

  await mkdir(bin);
  await mkdir(home);
  const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim();
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\ncase "$*" in\n  "repo view"*) echo '{"nameWithOwner":"o/r","owner":{"login":"o"}}' ;;\n  *) echo '[]' ;;\nesac\n`,
  );
  await writeFile(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`);
  await chmod(join(bin, 'gh'), 0o755);
  await chmod(join(bin, 'git'), 0o755);
  await writeFile(gitLog, '');

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FACTORY_HOME: home };
  const tick = (...args) => run('sh', [join(runner, 'factory', 'tick.sh'), ...args], { env, cwd: root });
  const head = () => git(runner, 'rev-parse', 'HEAD');
  const originHead = () => git(origin, 'rev-parse', 'main');
  const gitCalls = async () => (await readFile(gitLog, 'utf8')).split('\n').filter(Boolean);
  return { root, home, tick, head, originHead, gitCalls };
}

/**
 * Hold the runner's lock in another process until `release` is called. The
 * held command prints "held", and the lock command only starts it once the
 * lock is taken, so the tick starts after that line however slow the machine is.
 */
async function holdLock(home) {
  const { command, args } = lockCommand(process.platform, join(home, 'tick.lock'));
  // Its own process group, so release can end the lock command and the sleep under it together.
  const holder = spawn(command, [...args, 'sh', '-c', 'echo held; exec sleep 60'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  await new Promise((resolve, reject) => {
    let out = '';
    holder.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('held')) resolve();
    });
    holder.on('exit', (code) => reject(new Error(`the lock holder ended with ${code} before it took the lock`)));
  });
  return async () => {
    process.kill(-holder.pid, 'SIGTERM');
    await exited;
  };
}

test('a tick pulls main under the lock and then runs the code it pulled', async () => {
  const s = await setUp();
  try {
    const before = await s.head();
    const { stdout } = await s.tick();
    assert.match(stdout, /No ticket has the ready-after-pull label\./);
    assert.equal(await s.head(), await s.originHead());
    assert.notEqual(await s.head(), before);
    assert.deepEqual(
      (await s.gitCalls()).filter((call) => call.startsWith('pull')),
      ['pull --quiet --ff-only origin main'],
    );
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('a tick that starts while another run holds the lock pulls nothing', async () => {
  const s = await setUp();
  const release = await holdLock(s.home);
  try {
    const before = await s.head();
    const { stdout } = await s.tick();
    assert.match(stdout, /Another run holds the lock\./);
    assert.equal(await s.head(), before);
    assert.deepEqual(await s.gitCalls(), []);
  } finally {
    await release();
    await rm(s.root, { recursive: true, force: true });
  }
});

test('a dry run takes no lock and does not pull', async () => {
  const s = await setUp();
  const release = await holdLock(s.home);
  try {
    const before = await s.head();
    const { stdout } = await s.tick('--dry-run');
    // The lock is held, and the dry run still answers, from the code it started with.
    assert.match(stdout, /No ticket has the ready-for-agent label\./);
    assert.equal(await s.head(), before);
    assert.deepEqual(await s.gitCalls(), []);
  } finally {
    await release();
    await rm(s.root, { recursive: true, force: true });
  }
});
