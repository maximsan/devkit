// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runShell } from '../../lib/shared/processes.mjs';
import { detectPackageManager, main } from '../../lib/commands/nminstall.mjs';
import { runCli, tempWorkspace, testContext } from '../setup.mjs';
import { git, linkFolder, makeRepo, write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('nminstall');
const stateDir = join(workspace, 'state');

after(cleanup);

/**
 * Each case: files in the repo, package.json fields, and the expected command or skip reason.
 * @type {[Record<string, string>, Record<string, string>, string | RegExp][]}
 */
const CASES = [
  [{ 'package-lock.json': '{}' }, {}, 'npm ci'],
  [{ 'yarn.lock': '' }, {}, 'yarn install --frozen-lockfile'],
  [{ 'yarn.lock': '', '.yarnrc.yml': '' }, {}, 'yarn install --immutable'],
  [{ 'yarn.lock': '' }, { packageManager: 'yarn@4.5.0' }, 'yarn install --immutable'],
  [{ 'yarn.lock': '', '.yarnrc.yml': '' }, { packageManager: 'yarn@1.22.22' }, 'yarn install --frozen-lockfile'],
  [{ 'yarn.lock': '', 'package-lock.json': '{}' }, {}, /both/],
  [{}, {}, /no lockfile/],
  [{ 'pnpm-lock.yaml': '' }, {}, /pnpm or bun/],
  [{ 'package-lock.json': '{}' }, { packageManager: 'yarn@1.22.22' }, /packageManager says yarn/],
  [{ 'package-lock.json': '{}' }, { packageManager: 'pnpm@9.0.0' }, /uses pnpm/],
];

test('detectPackageManager covers npm, Yarn 1, Yarn 2+ and every skip case', async () => {
  for (const [index, [files, fields, expected]] of CASES.entries()) {
    const dir = join(workspace, 'cases', String(index));

    write(join(dir, 'package.json'), JSON.stringify({ name: 'x', ...fields }));

    for (const [file, content] of Object.entries(files)) {
      write(join(dir, file), content);
    }

    const plan = await detectPackageManager(dir);

    if (typeof expected === 'string') {
      assert.equal('command' in plan && plan.command, expected, `case ${index}`);
    } else {
      assert.match('skip' in plan ? plan.skip : '', expected, `case ${index}`);
    }
  }

  mkdirSync(join(workspace, 'cases', 'none'), { recursive: true });

  const none = await detectPackageManager(join(workspace, 'cases', 'none'));

  assert.match('skip' in none ? none.skip : '', /no package.json/);
});

test('install runs npm ci after confirmation and leaves the lockfile unchanged', async () => {
  const root = join(workspace, 'repos');
  const app = makeRepo(root, 'app');
  const lockfile = join(app, 'package-lock.json');
  const emptyLock = {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0' } },
  };

  write(lockfile, JSON.stringify(emptyLock));

  const lockBefore = readFileSync(lockfile, 'utf8');

  write(join(app, 'node_modules', 'stale.js'));

  const dryRun = testContext({ cwd: root, stateDir });

  assert.equal(await main(['--dry-run'], dryRun.context), 0);
  assert.match(dryRun.output(), /npm ci/);
  assert.equal(existsSync(join(app, 'node_modules', 'stale.js')), true);

  const applied = testContext({ cwd: root, stateDir });

  assert.equal(await main([], applied.context), 0, applied.output());
  assert.equal(existsSync(join(app, 'node_modules', 'stale.js')), false);
  assert.equal(readFileSync(lockfile, 'utf8'), lockBefore);
});

test('an existing node_modules that is a link or holds a nested repo is kept in the plan, not installed', async () => {
  const root = join(workspace, 'blocked');
  const linked = makeRepo(root, 'linked');
  const nested = makeRepo(root, 'nested');
  const shared = join(workspace, 'shared-modules');

  write(join(linked, 'package-lock.json'), '{}');
  write(join(shared, 'keep.js'));
  linkFolder(shared, join(linked, 'node_modules'));
  write(join(nested, 'package-lock.json'), '{}');
  write(join(nested, 'node_modules', 'patched-lib', '.git', 'HEAD'));

  const { context, output } = testContext({ cwd: root, stateDir });

  assert.equal(await main([], context), 0, output());
  assert.match(output(), /keep {2}linked .*existing node_modules is a symlink\/junction/);
  assert.match(output(), /keep {2}nested .*existing node_modules contains a nested git repo/);
  assert.match(output(), /Nothing to do/);
  assert.equal(existsSync(join(shared, 'keep.js')), true);
  assert.equal(existsSync(join(nested, 'node_modules', 'patched-lib', '.git', 'HEAD')), true);
});

test('as a process: prints the plan', () => {
  const root = join(workspace, 'process');
  const app = makeRepo(root, 'app');

  write(join(app, 'package-lock.json'), '{}');

  const dryRun = runCli(['install'], { cwd: root, stateDir });

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /do {4}app .*npm ci/);
});

test('a workspace node_modules containing tracked files blocks the whole install', async () => {
  const root = join(workspace, 'workspace-tracked');
  const repo = makeRepo(root, 'app', { ignore: '' });

  write(join(repo, 'package.json'), JSON.stringify({ name: 'app', workspaces: ['packages/*'] }));
  write(join(repo, 'package-lock.json'), '{}');
  write(join(repo, 'packages', 'web', 'package.json'), '{"name":"web"}');
  write(join(repo, 'packages', 'web', 'node_modules', 'keep.js'), 'keep');

  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'workspace');

  const { context, output } = testContext({ cwd: root, stateDir });

  await main(['--dry-run'], context);
  assert.match(output(), /keep {2}app .*packages\/web\/node_modules.*tracked/);
  assert.equal(readFileSync(join(repo, 'packages', 'web', 'node_modules', 'keep.js'), 'utf8'), 'keep');
});

test('unsupported workspace patterns and linked workspace paths refuse installation', async () => {
  const root = join(workspace, 'workspace-unsafe');
  const complex = makeRepo(root, 'complex');
  const linked = makeRepo(root, 'linked-workspace');
  const outside = join(workspace, 'external-workspace');

  write(join(complex, 'package.json'), JSON.stringify({ workspaces: ['packages/{a,b}'] }));
  write(join(complex, 'package-lock.json'), '{}');
  write(join(linked, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  write(join(linked, 'package-lock.json'), '{}');
  write(join(outside, 'package.json'), '{}');
  mkdirSync(join(linked, 'packages'), { recursive: true });
  linkFolder(outside, join(linked, 'packages', 'external'));

  const { context, output } = testContext({ cwd: root, stateDir });

  await main(['--dry-run'], context);
  assert.match(output(), /keep {2}complex .*unsupported workspace pattern/);
  assert.match(output(), /keep {2}linked-workspace .*workspace path is a link/);
});

test('rechecks workspace folders after confirmation before touching the root', async () => {
  const root = join(workspace, 'workspace-recheck');
  const repo = makeRepo(root, 'app', { ignore: 'node_modules/\n' });
  const target = join(repo, 'packages', 'web', 'node_modules');

  write(join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  write(join(repo, 'package-lock.json'), '{}');
  write(join(repo, 'packages', 'web', 'package.json'), '{}');
  write(join(repo, 'node_modules', 'keep.js'), 'root');
  write(join(target, 'a.js'), 'a');

  const { context, output } = testContext({ cwd: root, stateDir });

  context.confirm = async () => {
    write(join(target, 'nested', '.git', 'HEAD'), 'nested');

    return true;
  };

  assert.equal(await main([], context), 1);
  assert.match(output(), /nested git repo/);
  assert.equal(readFileSync(join(repo, 'node_modules', 'keep.js'), 'utf8'), 'root');
  assert.equal(readFileSync(join(target, 'a.js'), 'utf8'), 'a');
});

test('a safe workspace install removes existing workspace modules through the checked path', async () => {
  const root = join(workspace, 'workspace-install');
  const repo = makeRepo(root, 'app');
  const target = join(repo, 'packages', 'web', 'node_modules');

  write(join(repo, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
  write(join(repo, 'packages', 'web', 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0' }));

  const lock = await runShell('npm install --package-lock-only --ignore-scripts --offline', { cwd: repo });

  assert.equal(lock.ok, true, lock.output);
  write(join(repo, 'node_modules', 'stale.js'), 'stale');
  write(join(target, 'stale.js'), 'stale');

  const { context, output } = testContext({ cwd: root, stateDir });

  assert.equal(await main([], context), 0, output());
  assert.equal(existsSync(join(repo, 'node_modules', 'stale.js')), false);
  assert.equal(existsSync(join(target, 'stale.js')), false);
});

test('a recursive workspace pattern checks deeper package folders', async () => {
  const root = join(workspace, 'workspace-recursive');
  const repo = makeRepo(root, 'app', { ignore: '' });

  write(join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/**'] }));
  write(join(repo, 'package-lock.json'), '{}');
  write(join(repo, 'packages', 'area', 'web', 'package.json'), '{}');
  write(join(repo, 'packages', 'area', 'web', 'node_modules', 'tracked.js'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'workspace');

  const { context, output } = testContext({ cwd: root, stateDir });

  await main(['--dry-run'], context);
  assert.match(output(), /packages\/area\/web\/node_modules.*tracked/);
});
