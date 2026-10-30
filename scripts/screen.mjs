// @ts-check
// scripts/screen.mjs - run a command on a sample repos folder in a fake terminal and print the final screen as
// text, to see what a person sees. Not shipped in the package.
//   node scripts/screen.mjs nmclean --keys "space down space enter y enter"
// Keys: space, up, down, enter, esc, or text to type, such as y or a. Each key is sent when the command waits
// for one. Everything lives in a new temp folder, which is deleted at the end: the repos, the home folder,
// the temp folder, the state folder, and the npm and Yarn caches, so a picked cache clean never touches yours.

import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, findCommandName } from '../lib/commands/index.mjs';
import { runOnScreen } from '../tests/terminal.mjs';
import { backdate, makeRepo, write } from '../tests/utils.mjs';

const KEYS_FLAG = '--keys';
const EXIT_REFUSED = 2;
const KIB = 1024;

// Older than the age limits of devclean: 30 days for node_modules, 7 for build outputs and temp entries.
const OLD_DAYS = 40;

// The sample repos and the size of their node_modules in KB.
const SAMPLE_REPOS = Object.freeze([['web-app', 300], ['api-server', 120], ['old-tool', 50]]);

// More than the 10 largest a plan section shows before the pick list.
const OLD_TEMP_ENTRIES = 13;

// `process.argv` holds node and this file first.
const ARGS_START = 2;

/**
 * Set every file and folder under `folder`, and the folder itself, to `days` ago.
 * @param {string} folder  the folder
 * @param {number} days  how far back
 */
function backdateTree(folder, days) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const target = join(folder, entry.name);

    if (entry.isDirectory()) {
      backdateTree(target, days);
    } else {
      backdate(target, days);
    }
  }

  backdate(folder, days);
}

/**
 * The sample: repos with node_modules of different sizes, a workspace package, an old build output, .npmrc
 * files, one repo unchanged for weeks, old and new temp entries, and npm and Yarn caches.
 * @param {string} sandbox  the folder to build it in
 * @returns {{ repos: string, home: string, tempDir: string, stateDir: string }} where each part is
 */
function buildSample(sandbox) {
  const home = join(sandbox, 'home');
  const repos = join(home, 'repos');

  // Windows accepts a temp folder only at <home>\AppData\Local\Temp; macOS and Linux accept it there too.
  const tempDir = join(home, 'AppData', 'Local', 'Temp');

  for (const [name, kilobytes] of SAMPLE_REPOS) {
    const repo = makeRepo(repos, String(name));

    write(join(repo, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(Number(kilobytes) * KIB));
    write(join(repo, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_SampleToken0000abcd\n');
  }

  write(join(repos, 'api-server', 'packages', 'ui', 'package.json'), '{}');
  write(join(repos, 'api-server', 'packages', 'ui', 'node_modules', 'a.js'));
  write(join(repos, 'web-app', 'dist', 'main.js'));
  backdateTree(join(repos, 'web-app', 'dist'), OLD_DAYS);
  backdateTree(join(repos, 'old-tool'), OLD_DAYS);

  for (let index = 1; index <= OLD_TEMP_ENTRIES; index += 1) {
    write(join(tempDir, `old-${index}.tmp`), 'x'.repeat(index * KIB));
    backdate(join(tempDir, `old-${index}.tmp`), OLD_DAYS);
  }

  write(join(tempDir, 'new.tmp'));

  // npm and Yarn 1 read these, and devclean starts them with this process's environment.
  process.env.npm_config_cache = join(sandbox, 'npm-cache');
  process.env.YARN_CACHE_FOLDER = join(sandbox, 'yarn-cache');
  write(join(process.env.npm_config_cache, 'sample.tgz'), 'x'.repeat(KIB));
  write(join(process.env.YARN_CACHE_FOLDER, 'sample.tgz'), 'x'.repeat(KIB));

  return { repos, home, tempDir, stateDir: join(sandbox, 'state') };
}

const args = process.argv.slice(ARGS_START);
const keysAt = args.indexOf(KEYS_FLAG);
const keys = keysAt < 0 ? [] : (args[keysAt + 1] ?? '').split(' ').filter(Boolean);
const [name, ...argv] = keysAt < 0 ? args : [...args.slice(0, keysAt), ...args.slice(keysAt + 1 + 1)];
const command = name === undefined ? undefined : findCommandName(name);

if (!command) {
  console.error(`Usage: node scripts/screen.mjs <${Object.keys(COMMANDS).join('|')}> [options] [--keys "..."]`);
  process.exitCode = EXIT_REFUSED;
} else {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'devkit-screen-')));

  try {
    const { repos, ...folders } = buildSample(sandbox);
    const { code, screen } = await runOnScreen({ main: COMMANDS[command].main, command, argv, keys, cwd: repos,
      ...folders });

    console.log(screen.join('\n'));
    console.log(`\n[exit code ${code}]`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
