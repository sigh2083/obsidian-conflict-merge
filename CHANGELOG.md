# Changelog

## Unreleased

## 0.1.2

- Keep merge conflict resolution buttons visible on shorter displays by fitting the modal to the current window height.
- Move the compare table into a dynamically sized scroll region so long conflict reviews cannot push the action row off-screen.
- Improve narrow and low-height modal spacing so the review remains usable around 1440x810.

## 0.1.1

- Fix compare table styles so table rows are not affected by the old grid layout.
- Fix merged output so files that already end with a newline do not receive an extra blank line.
- Fix timestamped conflict merging by treating `<!-- edited: ... -->` as the end marker for a whole record block, then sorting merged blocks by their edited time.
- Treat whitespace-only line changes as visible differences by default.
- Document the future roadmap for changed-lines view, inline highlighting, navigation, editable merged candidates, and optional whitespace modes.

## 0.1.0

- Initial public release.
- Detect Obsidian Sync conflict files.
- Pair conflicted copies with likely original notes.
- Show original, conflict, and merged candidate in a review view.
- Generate conservative additive merge candidates.
- Support timestamp-aware paragraph insertion.
