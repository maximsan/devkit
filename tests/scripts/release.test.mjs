// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpVersion, localDate } from '../../scripts/release.mjs';

test('bumpVersion raises one number and resets the ones after it', () => {
  assert.equal(bumpVersion('2.3.1', 'major'), '3.0.0');
  assert.equal(bumpVersion('2.3.1', 'minor'), '2.4.0');
  assert.equal(bumpVersion('2.3.1', 'patch'), '2.3.2');
  assert.throws(() => bumpVersion('2.3', 'minor'));
  assert.throws(() => bumpVersion('2.3.1', 'huge'));
});

test('localDate pads the month and day', () => {
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});
