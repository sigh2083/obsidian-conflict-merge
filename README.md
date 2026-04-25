# Conflict Merge Assistant

Conflict Merge Assistant is an Obsidian plugin for reviewing Obsidian Sync conflict files and building conservative additive merge candidates.

It is designed for notes where conflicts usually come from appending new paragraphs, such as daily notes, work logs, meeting notes, and timestamped records. The plugin favors preservation over automatic deletion: it helps you compare the original note, the conflicted copy, and a proposed merged result before applying changes.

> Status: early public release. Please keep backups and review merge results before applying them to important notes.

## Features

- Detects Obsidian Sync conflict / conflicted-copy files.
- Finds the likely original note next to the conflict file.
- Shows a synchronized three-column review view:
  - original note
  - conflicted copy
  - merged candidate
- Builds additive merge candidates by preserving paragraphs from both sides.
- Uses timestamp-aware insertion when paragraph timestamps can be recognized.
- Falls back to stable ordered paragraph merging when timestamps are unavailable.
- Lets users tune the conflict filename pattern and timestamp patterns in settings.

## Merge Policy

This plugin intentionally behaves more like a paragraph union tool than a traditional destructive three-way merge.

1. Split both notes into paragraph blocks.
2. Find common paragraph anchors.
3. Compare the inserted paragraph ranges between common anchors.
4. If inserted paragraphs have recognizable timestamps, sort those additions by time.
5. Otherwise, preserve the observed paragraph order.
6. Generate a merged candidate that includes additions from both sides.

The plugin does not intentionally delete content from either side.

## Supported Timestamp Examples

- `<!-- edited: 2026-04-17 22:57:10 +03:00 -->`
- `09:42`
- `09:42:18`
- `2026-04-17 09:42`
- `2026-04-17T09:42:18`
- `2026/04/17 09:42`

The `<!-- edited: ... -->` form is recognized first because it is useful for append-only notes that preserve edit metadata.

## Good Fits

- Daily notes
- Meeting notes
- Project logs
- Timestamped work records
- Markdown files where most changes are additions rather than edits to old text

## Current Limits

- The merge model is paragraph-based, not character-based.
- Heavily rewritten paragraphs still need careful manual review.
- Obsidian Sync conflict file naming can vary, so the detection pattern may need adjustment.
- This is not a replacement for backups or version control.

## Installation

### Manual Install

1. Download or copy the files from `release/obsidian-conflict-merge/`.
2. Place them in your vault at:

   ```text
   .obsidian/plugins/obsidian-conflict-merge/
   ```

3. Enable `Conflict Merge Assistant` in Obsidian community plugin settings.

The installable bundle contains:

- `manifest.json`
- `versions.json`
- `main.js`
- `styles.css`

## Development

```bash
npm install
npm run build
npm run typecheck
```

During development, copy the built plugin files into your Obsidian vault plugin folder or use the `release/obsidian-conflict-merge/` bundle as the manual-install source.

## Repository Description

Suggested GitHub repository description:

```text
Review Obsidian Sync conflicted copies and build conservative additive merge candidates.
```

Suggested topics:

```text
obsidian, obsidian-plugin, markdown, sync, conflict-resolution, merge-tool
```

## License

MIT
