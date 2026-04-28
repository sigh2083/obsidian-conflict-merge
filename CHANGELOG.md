# Changelog

## Unreleased

- Fix compare table styles so table rows are not affected by the old grid layout.
- Fix merged output so files that already end with a newline do not receive an extra blank line.
- Treat whitespace-only line changes as visible differences by default.
- Document the future roadmap for changed-lines view, inline highlighting, navigation, editable merged candidates, and optional whitespace modes.

## 0.1.0

- Initial public release.
- Detect Obsidian Sync conflict files.
- Pair conflicted copies with likely original notes.
- Show original, conflict, and merged candidate in a review view.
- Generate conservative additive merge candidates.
- Support timestamp-aware paragraph insertion.
