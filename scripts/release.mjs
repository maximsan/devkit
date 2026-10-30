// @ts-check
// scripts/release.mjs - make a release: `node scripts/release.mjs <major|minor|patch>`. Not shipped in the package.
// Refuses unless the working tree is clean, docs/changelog/ has entries, and `npm run check` passes. Then it
// raises the version in package.json and package-lock.json, moves the entries into docs/CHANGELOG.md under the
// version and today's date, deletes the entry files, and commits. It pushes nothing.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENTRY_FOLDER, addRelease, readEntries } from './changelog.mjs';

const PARTS = ['major', 'minor', 'patch'];
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const JSON_INDENT = 2;
const DATE_PART_WIDTH = 2;
const TEXT_ENCODING = 'utf8';
const EXIT_REFUSED = 2;

const CHANGELOG = 'docs/CHANGELOG.md';
const PACKAGE = 'package.json';
const LOCKFILE = 'package-lock.json';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The next version after `version`.
 * @param {string} version  the current version, e.g. "2.3.0"
 * @param {string} part  which number to raise: major, minor or patch
 * @returns {string} the next version, e.g. "2.4.0" for minor
 */
export function bumpVersion(version, part) {
  const match = version.match(VERSION);

  if (!match || !PARTS.includes(part)) {
    throw new Error(`Cannot raise the ${part} number of version "${version}".`);
  }

  const [major, minor, patch] = match.slice(1).map(Number);

  if (part === 'major') {
    return `${major + 1}.0.0`;
  }

  return part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/**
 * Today in the local time zone, as YYYY-MM-DD.
 * @param {Date} now  the current time
 * @returns {string} the date
 */
export function localDate(now) {
  const pad = (/** @type {number} */ value) => String(value).padStart(DATE_PART_WIDTH, '0');

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Run git in the repo and return its output.
 * @param {string[]} args  git arguments
 * @returns {string} what git printed
 */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: TEXT_ENCODING });
}

/**
 * Read a JSON file of the repo, set its version, and write it back as npm formats it.
 * @param {string} file  the file, relative to the repo
 * @param {(json: { version: string, packages: Record<string, { version: string }> }) => void} setVersion
 *   changes the parsed file
 */
function updateJson(file, setVersion) {
  const path = `${ROOT}${file}`;
  const json = JSON.parse(readFileSync(path, TEXT_ENCODING));

  setVersion(json);
  writeFileSync(path, `${JSON.stringify(json, null, JSON_INDENT)}\n`);
}

/**
 * Make the release.
 * @param {string[]} argv  the arguments after the script name
 */
function main(argv) {
  const [part] = argv;

  if (argv.length !== 1 || !PARTS.includes(part)) {
    console.error(`Usage: node scripts/release.mjs <${PARTS.join('|')}>`);
    process.exitCode = EXIT_REFUSED;

    return;
  }

  if (git(['status', '--porcelain']).trim()) {
    throw new Error('The working tree has uncommitted changes: commit or stash them first.');
  }

  const { version: current } = JSON.parse(readFileSync(`${ROOT}${PACKAGE}`, TEXT_ENCODING));
  const version = bumpVersion(current, part);
  const entries = readEntries(`${ROOT}${ENTRY_FOLDER}`);

  if (!entries.length) {
    throw new Error(`${ENTRY_FOLDER}/ has no entries: there is nothing to release.`);
  }

  const released = readFileSync(`${ROOT}${CHANGELOG}`, TEXT_ENCODING);
  const changelog = addRelease(released, entries, version, localDate(new Date()));

  execSync('npm run check', { cwd: ROOT, stdio: 'inherit' });

  writeFileSync(`${ROOT}${CHANGELOG}`, changelog);

  for (const { file } of entries) {
    rmSync(`${ROOT}${ENTRY_FOLDER}/${file}`);
  }

  updateJson(PACKAGE, (json) => {
    json.version = version;
  });
  updateJson(LOCKFILE, (json) => {
    json.version = version;
    json.packages[''].version = version;
  });

  git(['add', '--', CHANGELOG, PACKAGE, LOCKFILE, ENTRY_FOLDER]);
  git(['commit', '--quiet', '-m', `chore: release ${version}`]);

  console.log(`Released ${version} (was ${current}) in one commit. Next: git push, then npm pack.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = EXIT_REFUSED;
  }
}
