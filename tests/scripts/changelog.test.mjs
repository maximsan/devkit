// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { addRelease, problemsIn, readEntries } from '../../scripts/changelog.mjs';
import { tempWorkspace } from '../setup.mjs';
import { write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('changelog');

after(cleanup);

const CHANGELOG = `# Changelog

Intro.

## 2.3.0 (2026-10-23)

### Changed

- An old thing.
`;

test('problemsIn accepts a well-formed entry and names each problem of a bad one', () => {
  assert.deepEqual(problemsIn('2026-10-27-esc-cancels.md', '### Fixed\n\n- Esc cancels.\n'), []);
  assert.deepEqual(problemsIn('Esc.md', '### Fixed\n\n- Esc cancels.\n'), [
    'the name is not YYYY-MM-DD-short-title.md, in lower case',
  ]);
  assert.match(problemsIn('2026-10-27-a.md', '### Faster\n\n- a\n').join(), /first line is not one of/);
  assert.equal(problemsIn('2026-10-27-a.md', '- a\n').length, 1);
  assert.match(problemsIn('2026-10-27-a.md', '### Added\n\n## 2.4.0\n- a\n').join(), /heading after the first line/);
  assert.match(problemsIn('2026-10-27-a.md', '### Added\n\n').join(), /no text under the heading/);
});

test('readEntries reads the entries oldest first, skips the rules file, takes CRLF, and refuses a bad entry', () => {
  const folder = join(workspace, 'entries');

  write(join(folder, 'README.md'), '# Rules\n');
  write(join(folder, '2026-10-28-later.md'), '### Added\n\n- Later.\n');
  write(join(folder, '2026-10-27-earlier.md'), '### Fixed\r\n\r\n- Earlier.\r\n');

  assert.deepEqual(readEntries(folder), [
    { file: '2026-10-27-earlier.md', kind: 'Fixed', body: '- Earlier.' },
    { file: '2026-10-28-later.md', kind: 'Added', body: '- Later.' },
  ]);

  write(join(folder, '2026-10-29-bad.md'), '- No heading.\n');
  assert.throws(() => readEntries(folder), /2026-10-29-bad\.md: the first line is not one of/);
});

test('addRelease puts the new version on top, grouped by kind in a fixed order, oldest first in each group', () => {
  const entries = [
    { file: '1', kind: 'Fixed', body: '- A fix.' },
    { file: '2', kind: 'Added', body: '- First feature.' },
    { file: '3', kind: 'Added', body: '- Second feature.' },
  ];
  const released = addRelease(CHANGELOG, entries, '2.4.0', '2026-10-27');

  assert.equal(released, `# Changelog

Intro.

## 2.4.0 (2026-10-27)

### Added

- First feature.
- Second feature.

### Fixed

- A fix.

## 2.3.0 (2026-10-23)

### Changed

- An old thing.
`);
});
