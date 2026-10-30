// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { daysAgo, pastTense, plural, tildePath } from '../../lib/shared/format.mjs';

test('plural, daysAgo and pastTense write counts, ages and action words as words', () => {
  assert.equal(plural(1, 'folder'), '1 folder');
  assert.equal(plural(0, 'folder'), '0 folders');
  assert.equal(plural(5, 'repo'), '5 repos');
  assert.equal(daysAgo(0), 'today');
  assert.equal(daysAgo(1), '1 day ago');
  assert.equal(daysAgo(12), '12 days ago');
  assert.deepEqual(
    ['delete', 'clean', 'update', 'install'].map(pastTense),
    ['deleted', 'cleaned', 'updated', 'installed'],
  );
});

test('tildePath writes the home folder as ~ and leaves other paths unchanged', () => {
  const home = join('/', 'home', 'me');

  assert.equal(tildePath(home, home), '~');
  assert.equal(tildePath(join(home, 'projects'), home), join('~', 'projects'));
  assert.equal(tildePath(join('/', 'home', 'meadow'), home), join('/', 'home', 'meadow'));
  assert.equal(tildePath(join('/', 'tmp'), home), join('/', 'tmp'));
});
