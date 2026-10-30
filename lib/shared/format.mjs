// @ts-check
// lib/shared/format.mjs - text for the output: sizes, ages and indented details.

import path from 'node:path';
import { DAY_MS } from './constants.mjs';
import { isInside, samePath } from './paths.mjs';

// DETAIL_INDENT and LINE_STARTS: keep in sync with gpall.mjs.
const DETAIL_INDENT = '    ';
const LINE_STARTS = /^/gm;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BYTES_PER_UNIT = 1024;

/**
 * Human-readable size, e.g. 1536 -> "1.5 KB".
 * @param {number | null | undefined} bytes  size, or nothing when unknown
 * @returns {string} the size with a unit, or an empty string when unknown
 */
export function formatBytes(bytes) {
  if (bytes == null) {
    return '';
  }

  let value = bytes;
  let unit = 0;

  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }

  return `${value.toFixed(unit ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

/**
 * Whole days between `mtimeMs` and `now`. A time after `now` (a change after planning, or a clock
 * ahead) counts as 0 days.
 * @param {number} mtimeMs  an earlier time
 * @param {number} now  the later time
 * @returns {number} full days in between
 */
export const ageInDays = (mtimeMs, now) => Math.max(0, Math.floor((now - mtimeMs) / DAY_MS));

/**
 * Indent every line of a text, for failure details under a heading.
 * @param {string} text  possibly multi-line text
 * @returns {string} the indented text
 */
export const indent = (text) => text.replace(LINE_STARTS, DETAIL_INDENT);

/**
 * Upper-case the first letter.
 * @param {string} word  e.g. "delete"
 * @returns {string} e.g. "Delete"
 */
export const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A count with its noun, e.g. "1 folder" or "5 folders". Only nouns that take an "s" in the plural.
 * @param {number} count  how many
 * @param {string} noun  the noun in the singular, e.g. "folder"
 * @returns {string} e.g. "5 folders"
 */
export const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * An age in days as words.
 * @param {number} days  whole days
 * @returns {string} "today", "1 day ago" or e.g. "5 days ago"
 */
export const daysAgo = (days) => (days ? `${plural(days, 'day')} ago` : 'today');

/**
 * The past tense of an action word that ends in "e" or takes "ed".
 * @param {string} verb  e.g. "delete" or "clean"
 * @returns {string} e.g. "deleted" or "cleaned"
 */
export const pastTense = (verb) => (verb.endsWith('e') ? `${verb}d` : `${verb}ed`);

/**
 * A path for the output, with the home folder written as "~", so it fits on a line.
 * @param {string} target  an absolute path
 * @param {string} home  the home folder
 * @returns {string} e.g. "~/projects", or the path unchanged when it is outside the home folder
 */
export function tildePath(target, home) {
  if (samePath(target, home)) {
    return '~';
  }

  return isInside(home, target) ? `~${path.sep}${path.relative(home, target)}` : target;
}
