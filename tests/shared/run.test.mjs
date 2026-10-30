// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIM, GREEN, RED, RESET, YELLOW } from '../../lib/shared/colors.mjs';
import { planAndRun, skippedItem } from '../../lib/shared/run.mjs';
import { tempWorkspace, testContext } from '../setup.mjs';
import { write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-run');

after(cleanup);

test('planAndRun attempts every item, returns exit code 1 on a failure, and refuses while locked', async () => {
  const stateDir = join(workspace, 'state');
  const { context } = testContext({ cwd: workspace, stateDir });
  const options = { yes: false, dryRun: false, help: false, jobs: 2 };

  /** @type {import('../../lib/shared/run.mjs').PlanItem[]} */
  const items = [
    { name: 'good', skip: null, run: async () => ({ ok: true, output: '' }) },
    { name: 'bad', skip: null, run: async () => ({ ok: false, output: 'boom' }) },
    {
      name: 'throws',
      skip: null,
      run: async () => {
        throw new Error('crash');
      },
    },
    skippedItem('kept', 'reason'),
  ];
  const sections = [{ title: 'test', items }];
  const run = await planAndRun({ sections, options, verb: 'clean', args: [], context });

  assert.equal(run.code, 1);
  assert.equal(run.applied, true);
  assert.deepEqual(
    run.results.map((result) => [result.name, result.ok, result.output]),
    [['good', true, ''], ['bad', false, 'boom'], ['throws', false, 'crash']],
  );

  write(join(stateDir, 'devkit.lock'), '999999\n');

  const whileLocked = planAndRun({ sections, options, verb: 'clean', args: [], context });

  await assert.rejects(whileLocked, /Another devkit script is running/);
});

test('in a terminal, only the picked groups run; nothing picked changes nothing; --yes skips the list', async () => {
  const stateDir = join(workspace, 'pick-state');

  /** @type {string[]} */
  const ran = [];

  /**
   * A plan item that records its name when it runs.
   * @param {string} name  the item's name
   * @param {string} group  its line in the pick list
   * @returns {import('../../lib/shared/run.mjs').PlanItem} the item
   */
  const item = (name, group) => ({
    name,
    group,
    skip: null,
    run: async () => {
      ran.push(name);

      return { ok: true, output: '' };
    },
  });
  const sections = [{ title: 'test', items: [item('a/1', 'a'), item('a/2', 'a'), item('b/1', 'b')] }];
  const options = { yes: false, dryRun: false, help: false, jobs: 1 };

  /**
   * Run the plan with these picks.
   * @param {import('../../lib/shared/run.mjs').RunContext} context  the run context
   * @param {boolean} yes  whether --yes is given
   * @returns {ReturnType<typeof planAndRun>} the outcome
   */
  const runWith = (context, yes = false) => planAndRun({
    sections, options: { ...options, yes }, verb: 'clean', args: [], context,
  });
  const picked = testContext({ cwd: workspace, stateDir, picks: [1] });

  await runWith(picked.context);
  assert.deepEqual(ran, ['b/1']);
  assert.match(picked.output(), /^a {2}2 items$/m);

  const none = testContext({ cwd: workspace, stateDir, picks: [] });
  const cancelled = await runWith(none.context);

  assert.equal(cancelled.applied, false);
  assert.match(none.output(), /Nothing picked/);

  ran.length = 0;

  const all = testContext({ cwd: workspace, stateDir, picks: [] });

  await runWith(all.context, true);
  assert.deepEqual(ran, ['a/1', 'a/2', 'b/1']);
  assert.doesNotMatch(all.output(), /items$/m);
});

test('a dry run ends with the commands that act on it', async () => {
  const stateDir = join(workspace, 'hint-state');
  const { context, output } = testContext({ cwd: workspace, stateDir, command: 'devclean' });
  const items = [{ name: 'one', skip: null, run: async () => ({ ok: true, output: '' }) }];
  const sections = [{ title: 'test', items }];
  const options = { yes: false, dryRun: true, help: false, jobs: 1 };

  await planAndRun({ sections, options, verb: 'clean', args: ['--days', '60'], context });
  assert.match(output(), /^ {2}devkit devclean --days 60 {8}pick and confirm, in a terminal$/m);
  assert.match(output(), /^ {2}devkit devclean --days 60 --yes {2}everything, without questions$/m);
});

test('in color, do is yellow, ok green, FAIL red, keep and the log line dim; the log file stays plain', async () => {
  const { context, output } = testContext({ cwd: workspace, stateDir: join(workspace, 'color-state'), colored: true });
  const items = [
    { name: 'good', skip: null, run: async () => ({ ok: true, output: '' }) },
    { name: 'bad', skip: null, run: async () => ({ ok: false, output: 'boom' }) },
    skippedItem('kept', 'reason'),
  ];
  const options = { yes: true, dryRun: false, help: false, jobs: 1 };

  await planAndRun({ sections: [{ title: 'test', items }], options, verb: 'clean', args: [], context });
  assert.ok(output().includes(`\n  ${YELLOW}do  ${RESET}  good`), output());
  assert.ok(output().includes(`\n  ${DIM}keep${RESET}  kept`), output());
  assert.ok(output().includes(`\n${GREEN}ok  ${RESET}  good`), output());
  assert.ok(output().includes(`\n${RED}FAIL${RESET}  bad`), output());

  const logLine = output().split('\n').find((line) => line.startsWith(`${DIM}Log: `)) ?? '';
  const logFile = logLine.slice(`${DIM}Log: `.length, -RESET.length);
  const logged = readFileSync(logFile, 'utf8');

  assert.match(logged, / FAIL bad \| boom$/m);
  assert.equal(logged.includes(RESET), false);
});

test('before the pick list a long section shows its largest items; a dry run shows them all', async () => {
  const stateDir = join(workspace, 'short-state');

  /**
   * A plan item of the given size.
   * @param {number} index  its number, which is also its size
   * @returns {import('../../lib/shared/run.mjs').PlanItem} the item
   */
  const sized = (index) => ({
    name: `entry-${index}`, bytes: index, group: 'all', skip: null, run: async () => ({ ok: true, output: '' }),
  });
  const sections = [{ title: 'test', items: Array.from({ length: 13 }, (_unused, index) => sized(index)) }];
  const options = { yes: false, dryRun: false, help: false, jobs: 1 };
  const asked = testContext({ cwd: workspace, stateDir, answer: false });

  await planAndRun({ sections, options, verb: 'delete', noun: 'file', args: [], context: asked.context });
  assert.match(asked.output(), /^ {2}do {4}entry-12 {2}12 B$/m);
  assert.match(asked.output(), /^ {2}do {4}entry-3 {3} 3 B$/m);
  assert.doesNotMatch(asked.output(), /entry-2 /);
  assert.match(asked.output(), /^ {2}\.\.\. and 3 more, 3 B in total; --dry-run lists them all$/m);

  const looked = testContext({ cwd: workspace, stateDir });

  const dryRun = { ...options, dryRun: true };

  await planAndRun({ sections, options: dryRun, verb: 'delete', args: [], context: looked.context });
  assert.match(looked.output(), /^ {2}do {4}entry-0 {3} 0 B$/m);
  assert.doesNotMatch(looked.output(), /more/);
});

test('after the pick, one line names the picked groups; the end line counts, sizes and failures', async () => {
  const stateDir = join(workspace, 'done-state');

  /**
   * A plan item in its own group.
   * @param {string} name  its name and group
   * @param {boolean} succeeds  whether its run succeeds
   * @returns {import('../../lib/shared/run.mjs').PlanItem} the item
   */
  const item = (name, succeeds) => ({
    name, bytes: 2048, skip: null, run: async () => ({ ok: succeeds, output: succeeds ? '' : 'boom' }),
  });
  const sections = [{ title: 'test', items: [item('a', true), item('b', true), item('c', false)] }];
  const options = { yes: false, dryRun: false, help: false, jobs: 1 };
  const { context, output } = testContext({ cwd: workspace, stateDir });

  await planAndRun({ sections, options, verb: 'delete', noun: 'folder', args: [], context });
  assert.match(output(), /^Picked: a, b, c$/m);
  assert.match(output(), /^Done: 2 of 3 folders deleted, 4\.0 KB freed; 1 failed, listed below\.$/m);
});
