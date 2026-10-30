// @ts-check
// scripts/changelog.mjs - the changelog entries in docs/changelog/: one file per change waiting for a release,
// so two branches never edit the same file. `node scripts/changelog.mjs` checks them (npm run check runs it);
// scripts/release.mjs moves them into docs/CHANGELOG.md. The rules are in docs/changelog/README.md.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The groups an entry can belong to, in the order a release lists them. */
export const KINDS = ['Added', 'Changed', 'Removed', 'Fixed'];
export const ENTRY_FOLDER = 'docs/changelog';

const RULES_FILE = 'README.md';
const FILE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const KIND_HEADING = /^### (.+)$/;
const ANY_HEADING = /^#{1,3} /m;
const VERSION_HEADING = /^## /m;

// Git on Windows checks text files out with CRLF line endings.
const CRLF = /\r\n/g;
const TEXT_ENCODING = 'utf8';
const EXIT_FAILED = 1;

/**
 * One change waiting for a release.
 * @typedef {{ file: string, kind: string, body: string }} Entry
 */

/**
 * What is wrong with one entry file.
 * @param {string} file  the file name
 * @param {string} text  its text
 * @returns {string[]} the problems; none means the entry is well-formed
 */
export function problemsIn(file, text) {
  const problems = [];
  const [first, ...rest] = text.split('\n');
  const kind = first.match(KIND_HEADING)?.[1];
  const body = rest.join('\n');

  if (!FILE_NAME.test(file)) {
    problems.push('the name is not YYYY-MM-DD-short-title.md, in lower case');
  }

  if (!kind || !KINDS.includes(kind)) {
    problems.push(`the first line is not one of: ${KINDS.map((name) => `### ${name}`).join(', ')}`);

    // Without the heading, the first line is the text: the checks below would only repeat the problem.
    return problems;
  }

  if (ANY_HEADING.test(body)) {
    problems.push('it has a heading after the first line');
  }

  if (!body.trim()) {
    problems.push('it has no text under the heading');
  }

  return problems;
}

/**
 * Read the entries in `folder`, oldest first. Refuses when any of them is not well-formed.
 * @param {string} folder  the entry folder
 * @returns {Entry[]} the entries
 */
export function readEntries(folder) {
  const files = readdirSync(folder).filter((file) => file !== RULES_FILE).sort();
  const entries = files.map((file) => ({
    file,
    text: readFileSync(path.join(folder, file), TEXT_ENCODING).replace(CRLF, '\n'),
  }));
  const problems = entries.flatMap(({ file, text }) => problemsIn(file, text).map((problem) => `${file}: ${problem}`));

  if (problems.length) {
    throw new Error(`Changelog entries in ${ENTRY_FOLDER}/ need fixing:\n  ${problems.join('\n  ')}`);
  }

  return entries.map(({ file, text }) => {
    const [first, ...rest] = text.split('\n');

    return { file, kind: first.slice('### '.length), body: rest.join('\n').trim() };
  });
}

/**
 * The changelog with a new version's section on top: the entries grouped by kind, oldest first in each group.
 * @param {string} changelog  docs/CHANGELOG.md
 * @param {Entry[]} entries  the entries to release
 * @param {string} version  the new version
 * @param {string} date  today, as YYYY-MM-DD
 * @returns {string} the changelog with the release
 */
export function addRelease(changelog, entries, version, date) {
  const groups = KINDS
    .map((kind) => ({ kind, bodies: entries.filter((entry) => entry.kind === kind).map((entry) => entry.body) }))
    .filter(({ bodies }) => bodies.length)
    .map(({ kind, bodies }) => `### ${kind}\n\n${bodies.join('\n')}\n`);
  const section = `## ${version} (${date})\n\n${groups.join('\n')}\n`;
  const first = changelog.search(VERSION_HEADING);

  if (first === -1) {
    return `${changelog.trimEnd()}\n\n${section}`;
  }

  return `${changelog.slice(0, first)}${section}${changelog.slice(first)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    readEntries(fileURLToPath(new URL(`../${ENTRY_FOLDER}`, import.meta.url)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = EXIT_FAILED;
  }
}
