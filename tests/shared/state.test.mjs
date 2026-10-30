// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyError } from '../../lib/shared/errors.mjs';
import { askInTerminal, isConfirmed } from '../../lib/shared/state.mjs';
import { fakeTerminal, KEYS } from '../terminal.mjs';

test('the y/N question goes ahead only on "y" or "yes"', () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' y ']) {
    assert.equal(isConfirmed(answer), true, answer);
  }

  for (const answer of ['', 'n', 'no', 'ye', 'yess', 'ok']) {
    assert.equal(isConfirmed(answer), false, answer);
  }
});

test('the question shows [y/N]; y goes ahead, Enter alone and n do not', async () => {
  for (const [typed, expected] of [['y\r', true], ['\r', false], ['n\r', false]]) {
    const { input, output, type, shown } = fakeTerminal();

    type(String(typed));
    assert.equal(await askInTerminal('Delete 1 file?', { input, output }), expected, JSON.stringify(typed));
    assert.match(shown(), /Delete 1 file\? \[y\/N\] \(Esc cancels\): /);
  }
});

test('Esc at the question cancels', async () => {
  const { input, output, type } = fakeTerminal();

  type(KEYS.esc);
  assert.equal(await askInTerminal('Delete?', { input, output }), false);
});

test('without an interactive terminal the question is refused', async () => {
  const { input, output } = fakeTerminal({ isTTY: false });

  await assert.rejects(askInTerminal('Delete?', { input, output }), SafetyError);
});
