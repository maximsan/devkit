// @ts-check
// Resolve supported workspace patterns without following links. Unknown patterns are refused.
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, NODE_MODULES, PACKAGE_JSON, TEXT_ENCODING } from '../shared/index.mjs';

const SIMPLE_COMPONENT = /^[A-Za-z0-9_@.-]+$/;
const STAR = '*';
const TRAILING_SLASH = /\/$/;
const GLOBSTAR = '**';
const EXCLUDED = new Set(['.git', NODE_MODULES]);

/**
 * Resolve workspace directories for the supported subset of npm and Yarn patterns.
 * @param {string} repo root directory
 * @returns {Promise<string[]>} root and workspace directories
 */
export async function installWorkspaces(repo) {
  const manifest = JSON.parse(await readFile(path.join(repo, PACKAGE_JSON), TEXT_ENCODING));
  const raw = manifest.workspaces;
  const patterns = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw.packages : raw;

  if (raw === undefined) {
    return [repo];
  }

  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string')) {
    throw new Error('unsupported workspace configuration');
  }

  const found = new Set([repo]);

  /**
   * Check a candidate without following links.
   * @param {string} dir candidate directory
   * @returns {Promise<boolean>} whether the candidate is a directory; links are refused
   */
  async function directory(dir) {
    let info;

    try {
      info = await lstat(dir);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        return false;
      }

      throw err;
    }

    if (info.isSymbolicLink()) {
      throw new Error(`workspace path is a link: ${path.relative(repo, dir)}`);
    }

    return info.isDirectory();
  }

  /**
   * Walk a supported pattern.
   * @param {string} dir current directory
   * @param {string[]} parts remaining pattern components
   * @returns {Promise<void>}
   */
  async function walk(dir, parts) {
    if (!parts.length) {
      const file = path.join(dir, PACKAGE_JSON);
      let info;

      try {
        info = await lstat(file);
      } catch (err) {
        if (errorCode(err) === 'ENOENT') {
          return;
        }

        throw err;
      }

      if (info.isSymbolicLink()) {
        throw new Error(`workspace manifest is a link: ${path.relative(repo, file)}`);
      }

      if (info.isFile()) {
        found.add(dir);
      }

      return;
    }

    const [part, ...rest] = parts;

    if (part !== STAR && part !== GLOBSTAR) {
      const next = path.join(dir, part);

      if (await directory(next)) {
        await walk(next, rest);
      }

      return;
    }

    if (part === GLOBSTAR) {
      await walk(dir, rest);
    }

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || EXCLUDED.has(entry.name)) {
        continue;
      }

      const next = path.join(dir, entry.name);

      if (await directory(next)) {
        await walk(next, part === GLOBSTAR ? parts : rest);
      }
    }
  }

  for (const pattern of /** @type {string[]} */ (patterns)) {
    const parts = pattern.replace(TRAILING_SLASH, '').split('/');

    if (!parts.length || parts.some((part) => part !== STAR && part !== GLOBSTAR
      && (!SIMPLE_COMPONENT.test(part) || part === '.' || part === '..' || EXCLUDED.has(part)))) {
      throw new Error('unsupported workspace pattern');
    }

    await walk(repo, parts);
  }

  return [...found].sort();
}
