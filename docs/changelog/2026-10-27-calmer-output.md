### Changed

- Counts and ages are words: "5 folders", "4 repos", "today", "1 day ago" instead of "item(s)" and "day(s)".
- Paths in your home folder are written with `~`, such as `~/projects`.
- In a plan, sizes are right-aligned, and the `do` word is yellow where the terminal shows colors.
- Before the pick list, a section with more than 10 items to do shows its 10 largest and one `... and N more` line. `--dry-run` still lists every item.
- The pick list closes into one `Picked:` line.
- The end line gives the size freed, such as `Done: 2 folders deleted, 585.9 KB freed.` The log path is on its own dim line.
