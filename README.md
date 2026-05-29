# RoseReader

[English](README.md) | [简体中文](README.zh-CN.md)

RoseReader is a local-first Electron reader for EPUB, PDF, TXT, and Markdown books. It is built around a smooth infinite-scroll reading flow, durable reading state, and a library model that works well with real folders on disk.

## Overview

RoseReader is aimed at people who keep their books locally and want a lightweight reader with practical tools rather than a store, sync service, or heavy catalog system.

It focuses on:
- local libraries backed by folders, plus optional logical collections
- infinite-scroll reading for EPUB, TXT, and Markdown
- PDF reading with text search and page-level highlights
- persistent search indexes for faster repeated in-book searches
- durable progress, bookmarks, highlights, notes, and moved-book recovery

## Key Features

### Library & Organization

- Import local directories as physical libraries.
- Create logical libraries for custom collections without moving source files.
- Browse folder trees, create folders, and move books between folders.
- Optionally move the underlying file on disk when reorganizing a physical library.
- Auto-watch library folders and refresh changed/new books.
- Sort and search the library with quick keyboard-style lookup.
- Recover reading state when a book is moved, and merge duplicate/moved records from Settings.

### Reader Experience

- Read EPUB, PDF, TXT, Markdown, and common Markdown extension variants.
- Infinite-scroll EPUB rendering with precise resume snapshots.
- Markdown rendered view plus raw/regional raw reading controls.
- PDF canvas rendering with text layer search, highlights, zoom, and recolor support.
- TOC navigation for supported books, with fallback/generated navigation when needed.
- Generated TXT table of contents for plain-text books that expose chapter-like headings.
- Bookmarks, highlights, nested highlights, PDF page highlights, and notes.
- In-book search with codemap-style result markers and lazy PDF highlight rendering.
- Selection popup actions for quick Google and Google AI Mode lookup.

### Customization & i18n

- Reader settings for font, size, spacing, margins, PDF zoom, TOC width, and TOC auto-hide delay.
- Reader theme presets: Archive, Warm, Cream, Sepia, Paper, and Night.
- Archive Paper is the default reading theme, with warm paper background, dark brown text, muted side text, and orange-gold emphasis/search colors.
- UI locale setting with system locale detection.

### Durability & Performance

- Progress, last-read time, completion state, reading analytics, and reading history are persisted locally.
- Bookmarks, highlights, notes, generated TXT TOCs, and in-book search indexes are stored with the book record.
- Persistent search indexes are reused when the file signature still matches, avoiding repeated full-text extraction for stable books.
- Generated TXT TOCs are cached by file signature and regenerated when the source file changes.
- Library scans mark unavailable files as missing instead of immediately discarding reading state.
- Export/import actions are available for the local data store.

## Screenshots

### Main Reading UI

![Main reading view](imgs/屏幕截图_20260213_170601.png)
![Reader controls](imgs/屏幕截图_20260213_170407.png)
![Progress panel](imgs/屏幕截图_20260213_170405.png)

### Nested Highlights & Locator

![Nested highlights](imgs/image%203.png)

### Search Codemap Style Hints

![Search codemap](imgs/屏幕截图_20260213_175358.png)

### Library Search

![Library search](imgs/屏幕截图_20260213_175411.png)

### Selection to Google AI Mode

![Selection actions](imgs/屏幕截图_20260213_175722.png)
![Google AI Mode lookup](imgs/屏幕截图_20260213_175730.png)

## Tech Stack

- Electron
- Node.js
- `epub2`
- `pdf-parse`
- `pdfjs-dist`

## Installation

### Windows

Currently, the most reliable way on Windows is running from source:

1. Install Node.js 20+.
2. Clone this repository.
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm start
```

### Linux

#### Option A: Run from source

```bash
npm install
npm start
```

#### Option B: Arch Linux package (`PKGBUILD`)

```bash
makepkg -si
```

The root `PKGBUILD` builds a pacman package that uses the system Electron runtime. It does not produce release artifacts through `electron-builder`.

Installed layout:
- app files: `/usr/lib/rosereader`
- launcher: `/usr/bin/rosereader`
- desktop entry: `/usr/share/applications/rosereader.desktop`
- icon: `/usr/share/icons/hicolor/scalable/apps/rosereader.svg`

The launcher exports:

```text
ROSE_DATA_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/RoseReader
```

On Linux, `npm start` and the packaged app share this same persistence directory, so reading progress and annotations are not split.

## Development

Requirements:
- Node.js 20+

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm start
```

Build and install the Arch Linux package:

```bash
makepkg -si
```

## Data Storage

Data is persisted under the app data directory as:
- `rosereader-data.json`
- `rosereader-data-backup.json`
- `covers/` (generated cover cache)

Stored content includes:
- libraries, logical library mappings, and books
- reading progress/history and analytics
- bookmarks/highlights/notes
- settings, including reader theme and locale
- generated TXT TOC cache (heading titles and line boundaries only; source text stays in the original file)
- persistent in-book search index cache (plain searchable text by chapter/page)

Search indexes and generated TXT TOCs are tied to file signatures, so they can be reused for stable reading files and refreshed when the file changes.

## Project Structure

- `main.js`: Electron main process, scanning/import, persistence, IPC, migrations, parsing, and packaging-time runtime behavior.
- `index.html`: renderer UI, reader styling, localization strings, and app interaction logic.
- `search-index.js`: reusable in-book search index building, validation, and search helpers.
- `PKGBUILD`: Arch Linux packaging entry point using system Electron.
- `rosereader.desktop`: Linux desktop launcher metadata.
- `icon.svg`: application icon used by the package.

## License

MIT
