# Changelog entries

Each change a user notices waits here for the next release, as its own file. Two branches then never edit the same
file, so they never conflict over the changelog.

- The file is named `YYYY-MM-DD-short-title.md`, in lower case, e.g. `2026-10-27-esc-cancels-the-pick-list.md`.
- Its first line is the group it belongs to: `### Added`, `### Changed`, `### Removed` or `### Fixed`.
- Below it, one or more `- ` lines, as they will read in [CHANGELOG.md](../CHANGELOG.md). It has no other heading.
- Links start from `docs/`, as in CHANGELOG.md, e.g. `adr/0003-confirm-no-schedule.md`.

`npm run check` checks every entry. `node scripts/release.mjs <major|minor|patch>` moves the entries into
CHANGELOG.md under the new version and date, grouped, oldest first, and deletes the files.
