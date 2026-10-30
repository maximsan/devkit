// @ts-check
// tests/terminal.mjs - a fake terminal for tests and scripts/screen.mjs: keys go in, output comes out, and
// screenOf replays the cursor codes in that output into the lines a person would see.

import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { processContext } from '../lib/shared/state.mjs';

const ESC = '\u001B';

// One cursor or color code, a carriage return, a line break, or a run of plain text.
const OUTPUT_PARTS = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])|\\r|\\n|[^${ESC}\\r\\n]+`, 'g');

/** Key names that scripts/screen.mjs and tests can press, and what the terminal sends for each. */
export const KEYS = Object.freeze({
  space: ' ',
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  enter: '\r',
  esc: ESC,
});

// Output this long without a change means the program waits for a key.
const IDLE_MS = 50;

// node:readline waits this long after Esc for the rest of an escape sequence; the next key must come later.
const ESC_WAIT_MS = 600;

const POLL_MS = 10;
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 40;

/**
 * The lines a terminal shows after it receives `text`: cursor moves and erases are applied, colors dropped.
 * Handles the codes node:readline and the scripts write: up, down, column, erase below, erase line.
 * @param {string} text  everything written to the terminal
 * @returns {string[]} the lines, without trailing spaces and trailing empty lines
 */
export function screenOf(text) {
  /** @type {string[]} */
  const lines = [''];
  let row = 0;
  let column = 0;

  for (const [part, params, code] of text.matchAll(OUTPUT_PARTS)) {
    const count = Number(params) || 1;

    if (part === '\r') {
      column = 0;
    } else if (part === '\n') {
      row += 1;
      column = 0;
      lines[row] ??= '';
    } else if (code === 'A') {
      row = Math.max(0, row - count);
    } else if (code === 'B') {
      row += count;
      lines[row] ??= '';
    } else if (code === 'G') {
      column = count - 1;
    } else if (code === 'J') {
      lines.length = row + 1;
      lines[row] = lines[row].slice(0, column);
    } else if (code === 'K') {
      lines[row] = lines[row].slice(0, column);
    } else if (!code) {
      const line = lines[row].padEnd(column);

      lines[row] = line.slice(0, column) + part + line.slice(column + part.length);
      column += part.length;
    }
  }

  const trimmed = lines.map((line) => line.trimEnd());

  while (trimmed.length && !trimmed[trimmed.length - 1]) {
    trimmed.pop();
  }

  return trimmed;
}

/**
 * A fake interactive terminal.
 * @param {{ isTTY?: boolean, rawMode?: boolean, colored?: boolean, columns?: number, rows?: number }} [options]
 *   whether it looks like a terminal, whether it sends single keypresses, whether it shows colors, and its size
 * @returns {{
 *   input: NodeJS.ReadStream, output: NodeJS.WriteStream, type: (text: string) => void,
 *   press: (keys: string[]) => Promise<void>, close: () => void, shown: () => string, screen: () => string[],
 * }} the streams to pass; `type` sends text on the next turn of the event loop; `press` sends each key once the
 *   program waits for one (a name from KEYS, or text to type); `close` drops the keys not yet sent, for a
 *   program that ended; everything shown so far, and as screen lines
 */
export function fakeTerminal({
  isTTY = true, rawMode = true, colored = false, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS,
} = {}) {
  const input = Object.assign(new PassThrough(), {
    isTTY,
    setRawMode: () => {
      if (!rawMode) {
        throw new Error('raw mode is not supported');
      }
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY, columns, rows, hasColors: () => colored });
  let shown = '';
  let changed = Date.now();
  let closed = false;

  output.on('data', (chunk) => {
    shown += chunk;
    changed = Date.now();
  });

  /** Wait until something listens for keys and the output has been still for a moment. */
  const waitForPrompt = async () => {
    while (!closed && (!input.listenerCount('keypress') || Date.now() - changed < IDLE_MS)) {
      await sleep(POLL_MS);
    }
  };

  return {
    input: /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (input)),
    output: /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (output)),
    type: (text) => setImmediate(() => input.write(text)),
    press: async (keys) => {
      for (const key of keys) {
        await waitForPrompt();

        if (closed) {
          return;
        }

        input.write(KEYS[/** @type {keyof KEYS} */ (key)] ?? key);
        await sleep(key === 'esc' ? ESC_WAIT_MS : IDLE_MS);
      }
    },
    close: () => {
      closed = true;
    },
    shown: () => shown,
    screen: () => screenOf(shown),
  };
}

/**
 * Run a command's main on a fake terminal, as a person in a terminal would: the real pick list and y/N question,
 * with `keys` pressed as each one waits.
 * @param {{
 *   main: (argv: string[], context: import('../lib/shared/state.mjs').RunContext) => Promise<number>,
 *   command: string, argv?: string[], keys?: string[], cwd: string, home: string, stateDir: string, tempDir: string,
 *   colored?: boolean,
 * }} run  the command, its name and arguments, the keys to press, and the folders it sees
 * @returns {Promise<{ code: number, screen: string[] }>} the exit code and the final screen
 */
export async function runOnScreen({
  main, command, argv = [], keys = [], cwd, home, stateDir, tempDir, colored = false,
}) {
  const terminal = fakeTerminal({ colored });
  const context = {
    ...processContext(command, { input: terminal.input, output: terminal.output, status: terminal.output }),
    cwd,
    home,
    stateDir,
    tempDir,
    env: { ...process.env, LOCALAPPDATA: stateDir },
  };
  const finished = main(argv, context).finally(terminal.close);

  await terminal.press(keys);

  const code = await finished;

  context.progress.stop();

  return { code, screen: terminal.screen() };
}
