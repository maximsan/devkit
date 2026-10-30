// @ts-check
// lib/shared/run.mjs - plan items, running them in a pool, and the shared plan -> confirm -> run flow with its output.

import { EXIT_FAILED, EXIT_OK } from './constants.mjs';
import { errorText } from './errors.mjs';
import { capitalize, formatBytes, indent, pastTense, plural, tildePath } from './format.mjs';
import { createLog, withLock } from './state.mjs';

/** @typedef {import('./state.mjs').RunContext} RunContext */

/**
 * Outcome of one action. `summary` replaces the plan detail on the ok line, e.g. a value read back after writing.
 * @typedef {{ ok: boolean, output: string, summary?: string }} RunResult
 */

/** @typedef {RunResult & { name: string }} Result  one finished plan item */

/**
 * One line of a plan. `skip` holds the reason it is kept; `run` performs it and never rejects. `group` is
 * the item's line in the pick list, e.g. its repo; items without one get a line each.
 * @typedef {{
 *   name: string, detail?: string, bytes?: number | null, skip: string | null, run: () => Promise<RunResult>,
 *   group?: string,
 * }} PlanItem
 */

/** @typedef {{ title: string, items: PlanItem[] }} PlanSection */

/**
 * The action words and item nouns a command may pass. Each takes the regular endings that pastTense and plural
 * add ("deleted", "folders"); a new word is added here once its endings are checked.
 * @typedef {'delete' | 'install' | 'update' | 'clean'} Verb
 * @typedef {'item' | 'folder' | 'repo' | 'file'} Noun
 */

/**
 * Flags every script accepts. `dryRun` only prints the plan; `yes` takes every item without the pick list
 * and the confirmation, also without a terminal.
 * @typedef {{ yes: boolean, dryRun: boolean, help: boolean, jobs: number }} BaseOptions
 */

const WHITESPACE_RUNS = /\s+/g;

// One group leaves nothing to pick between.
const MIN_GROUPS_TO_PICK = 2;

// Before the pick list, a section shows at most this many of its largest items; --dry-run shows them all.
const SHORT_SECTION_ITEMS = 10;

// The "Picked:" line names at most this many lines of the pick list.
const PICKED_NAMES_SHOWN = 5;

/**
 * Column widths of the plan and result lines: the longest name, and the longest size.
 * @typedef {{ name: number, size: number }} Columns
 */

/**
 * Run `worker` over `items` with at most `limit` running at once. Keep in sync with gpall.mjs.
 * @template T, R
 * @param {readonly T[]} items  inputs
 * @param {number} limit  most workers running at once
 * @param {(item: T) => Promise<R>} worker  handles one input
 * @returns {Promise<R[]>} results in input order
 */
export async function mapPool(items, limit, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;

  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(lanes);

  return results;
}

/**
 * A plan line that is shown as kept and never runs.
 * @param {string} name  what the line is about
 * @param {string} reason  why it is kept
 * @returns {PlanItem} the plan line
 */
export const skippedItem = (name, reason) => ({ name, skip: reason, run: async () => ({ ok: false, output: reason }) });

/**
 * Total size of plan items whose size is known.
 * @param {PlanItem[]} items  plan lines
 * @returns {number} bytes
 */
const totalBytes = (items) => items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

/**
 * Size and detail of a plan line, for the output. The size is right-aligned, so the units line up.
 * @param {PlanItem} item  plan line
 * @param {number} sizeWidth  the size column's width; 0 when no item has a size
 * @returns {string} e.g. "  1.5 KB  leftover of an earlier run"
 */
const describe = (item, sizeWidth) => [formatBytes(item.bytes).padStart(sizeWidth), item.detail]
  .filter(Boolean)
  .join('  ');

/**
 * The column widths for a set of plan lines.
 * @param {PlanItem[]} items  plan lines
 * @returns {Columns} the widths
 */
const columnsOf = (items) => ({
  name: Math.max(0, ...items.map((item) => item.name.length)),
  size: Math.max(0, ...items.map((item) => formatBytes(item.bytes).length)),
});

/**
 * Names for a one-line summary: the first few, then how many more.
 * @param {string[]} names  the names
 * @returns {string} e.g. "app, lib and 3 more"
 */
function nameList(names) {
  const shown = names.slice(0, PICKED_NAMES_SHOWN).join(', ');
  const more = names.length - PICKED_NAMES_SHOWN;

  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * The item's line in the pick list.
 * @param {PlanItem} item  plan line
 * @returns {string} its group, or its name without one
 */
const groupOf = (item) => item.group ?? item.name;

/**
 * Let the person pick which groups of items to run, then name the picked groups on one line. With fewer than
 * two groups there is nothing to pick.
 * @param {PlanSection[]} sections  the plan
 * @param {{ verb: Verb, noun: Noun, context: RunContext }} words  the action word, e.g. "delete"; what an
 *   item is, e.g. "folder"; and the run context, which asks the person and prints
 * @returns {Promise<PlanSection[] | null>} the plan with only the picked groups, or null when none was picked
 */
async function pickGroups(sections, { verb, noun, context }) {
  /** @type {Map<string, PlanItem[]>} */
  const groups = new Map();

  for (const item of sections.flatMap((section) => section.items).filter((planned) => !planned.skip)) {
    groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);
  }

  if (groups.size < MIN_GROUPS_TO_PICK) {
    return sections;
  }

  const names = [...groups.keys()];
  const sizes = names.map((name) => {
    const bytes = totalBytes(groups.get(name) ?? []);

    return bytes ? formatBytes(bytes) : '';
  });
  const width = Math.max(...names.map((name) => name.length));
  const sizeWidth = Math.max(...sizes.map((size) => size.length));
  const labels = names.map((name, index) => {
    const count = groups.get(name)?.length ?? 0;

    return [name.padEnd(width), sizes[index].padStart(sizeWidth), count > 1 ? plural(count, noun) : '']
      .filter(Boolean)
      .join('  ')
      .trimEnd();
  });

  // A blank line between the plan and the pick list; the list closes into the "Picked:" line below it.
  context.print();

  const picked = new Set((await context.pick(`Pick what to ${verb}:`, labels)).map((index) => names[index]));

  if (!picked.size) {
    return null;
  }

  context.print(`Picked: ${nameList([...picked])}`);

  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => picked.has(groupOf(item))) }))
    .filter((section) => section.items.length);
}

/**
 * A plan section as printed: all its lines, or, when short, only its largest items to do in plan order.
 * @typedef {{ title: string, shown: PlanItem[], hidden: PlanItem[] }} SectionView
 */

/**
 * Which lines of a section are printed.
 * @param {PlanSection} section  the section
 * @param {boolean} short  whether to show only the largest items to do
 * @returns {SectionView} the printed and the hidden lines
 */
function viewOf({ title, items }, short) {
  const bySize = items.filter((item) => !item.skip).sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0));
  const hidden = new Set(short ? bySize.slice(SHORT_SECTION_ITEMS) : []);

  return { title, shown: items.filter((item) => !hidden.has(item)), hidden: [...hidden] };
}

/**
 * Print one plan section: a title, a "do" or "keep" line per shown item, and one line for the hidden items.
 * @param {SectionView} view  the section to print
 * @param {Columns} columns  the column widths
 * @param {RunContext} context  where output goes, and how a status word is colored
 */
function printSection({ title, shown, hidden }, columns, { print, paint }) {
  print(`\n${title}`);

  if (!shown.length) {
    print('  (nothing found)');
  }

  for (const item of shown) {
    const action = item.skip ? paint('quiet', 'keep') : paint('act', 'do  ');
    const detail = item.skip ?? describe(item, columns.size);

    print(`  ${action}  ${item.name.padEnd(columns.name)}  ${detail}`.trimEnd());
  }

  if (hidden.length) {
    const size = totalBytes(hidden) ? `, ${formatBytes(totalBytes(hidden))} in total` : '';

    print(paint('quiet', `  ... and ${hidden.length} more${size}; --dry-run lists them all`));
  }
}

/**
 * Run plan items in a pool. Every item is attempted; failures are returned as data.
 * @param {PlanItem[]} items  plan lines to run
 * @param {{
 *   jobs: number,
 *   log?: (line: string) => Promise<void>,
 *   onResult?: (result: Result, item: PlanItem) => void,
 * }} options  parallel items, a log writer, and a callback per finished item
 * @returns {Promise<Result[]>} in input order
 */
async function runItems(items, { jobs, log = async () => {}, onResult = () => {} }) {
  return mapPool(items, jobs, async (item) => {
    /** @type {RunResult} */
    const outcome = await item.run().catch((err) => ({ ok: false, output: errorText(err) }));
    const failure = outcome.ok ? '' : ` | ${outcome.output.replace(WHITESPACE_RUNS, ' ')}`;

    await log(`${outcome.ok ? 'ok  ' : 'FAIL'} ${item.name}${failure}`);

    const result = { name: item.name, ok: outcome.ok, output: outcome.output, summary: outcome.summary };

    onResult(result, item);

    return result;
  });
}

/**
 * The line after a run: how many items ran, the size freed, and how many failed.
 * @param {Result[]} results  each item's result
 * @param {PlanItem[]} items  the items, in the order of the results
 * @param {{ verb: Verb, noun: Noun }} words  the action word, e.g. "delete", and what an item is, e.g. "folder"
 * @returns {string} e.g. "Done: 3 of 5 folders deleted, 1.5 MB freed; 2 failed, listed below."
 */
function doneLine(results, items, { verb, noun }) {
  const succeeded = items.filter((_item, index) => results[index].ok);
  const failed = results.length - succeeded.length;
  const count = failed ? `${succeeded.length} of ${plural(results.length, noun)}` : plural(results.length, noun);
  const freed = totalBytes(succeeded) ? `, ${formatBytes(totalBytes(succeeded))} freed` : '';
  const failures = failed ? `; ${failed} failed, listed below` : '';

  return `Done: ${count} ${pastTense(verb)}${freed}${failures}.`;
}

/**
 * The shared flow: print the plan -> stop when it only looks -> pick groups and confirm (unless --yes) ->
 * lock -> runItems, printing ok/FAIL per item as it finishes -> list failures with details at the end.
 * A run only looks with --dry-run, or without --yes where no person can answer (docs/adr/0003). Before the
 * pick list, a long section shows only its largest items: the pick list follows, and --dry-run shows them all.
 * @param {{
 *   sections: PlanSection[], options: BaseOptions, verb: Verb, noun?: Noun, args: string[], context: RunContext,
 * }} args  the plan; the parsed flags; the action word for messages ("delete"); what an item is, in the
 *   singular ("folder"); the command's arguments as the hints repeat them; and the run context, whose command
 *   name the hints and the log file use
 * @returns {Promise<{ code: number, applied: boolean, results: Result[] }>}
 *   exit code, whether the items ran to the end, and each item's result (none without a run)
 */
export async function planAndRun({ sections, options, verb, noun = 'item', args, context }) {
  const { command, print, progress, paint } = context;
  const asks = !options.yes && !options.dryRun && context.interactive;

  progress.stop();

  // The longest name sets the name column, so the sizes line up (keep in sync with gpall.mjs); the longest
  // size sets the size column, so the units line up. Hidden lines don't count.
  const views = sections.map((section) => viewOf(section, asks));
  const columns = columnsOf(views.flatMap((view) => view.shown));

  for (const view of views) {
    printSection(view, columns, context);
  }

  const planned = sections.flatMap((section) => section.items).filter((item) => !item.skip);

  if (!planned.length) {
    print('\nNothing to do.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  if (options.dryRun || !(options.yes || context.interactive)) {
    const shown = args.filter((arg) => arg !== '--dry-run');
    const size = totalBytes(planned) ? ` (${formatBytes(totalBytes(planned))})` : '';

    const asking = `devkit ${[command, ...shown].join(' ')}`;
    const unasked = `devkit ${[command, ...shown, '--yes'].join(' ')}`;

    print(`\nDry run: nothing changed. To ${verb} ${plural(planned.length, noun)}${size}:`);
    print(`  ${asking.padEnd(unasked.length)}  pick and confirm, in a terminal`);
    print(`  ${unasked}  everything, without questions`);

    return { code: EXIT_OK, applied: false, results: [] };
  }

  const picked = options.yes ? sections : await pickGroups(sections, { verb, noun, context });

  if (!picked) {
    print('Nothing picked. Nothing was changed.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  const todo = picked.flatMap((section) => section.items).filter((item) => !item.skip);
  const size = totalBytes(todo) ? ` (${formatBytes(totalBytes(todo))})` : '';
  const question = `\n${capitalize(verb)} ${plural(todo.length, noun)}${size}?`;

  if (!options.yes && !(await context.confirm(question))) {
    print('Cancelled. Nothing was changed.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  return withLock(context.stateDir, async () => {
    const { file, log } = await createLog(context.stateDir, command);
    const runColumns = columnsOf(todo);

    print();
    progress.start(capitalize(verb), todo.length);

    const results = await runItems(todo, {
      jobs: options.jobs,
      log,
      onResult: (result, item) => {
        const detail = result.summary ?? describe(item, runColumns.size);
        const status = result.ok ? paint('ok', 'ok  ') : paint('fail', 'FAIL');

        print(`${status}  ${result.name.padEnd(runColumns.name)}  ${detail}`.trimEnd());
        progress.advance();
      },
    });

    progress.stop();

    const failed = results.filter((result) => !result.ok);

    print(`\n${doneLine(results, todo, { verb, noun })}`);
    print(paint('quiet', `Log: ${tildePath(file, context.home)}`));

    for (const result of failed) {
      print(`\n--- ${result.name}\n${indent(result.output)}`);
    }

    return { code: failed.length ? EXIT_FAILED : EXIT_OK, applied: true, results };
  });
}
