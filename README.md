# RoseReader

RoseReader is a vibe-coding project: a simple cross-platform EPUB/PDF/TXT reader with an infinite-scrolling reading experience.

## What It Is

RoseReader is built with Electron and focuses on:
- fast local-library import from folders
- smooth infinite scrolling for EPUB chapters
- PDF and TXT support
- reading continuity: progress, bookmarks, highlights, notes

## Core Features

- Library management
  - import directories as libraries
  - folder tree navigation
  - move books between folders (optionally move files on disk)
- Reader
  - infinite-scroll EPUB rendering
  - PDF rendering via `pdfjs-dist`/`pdf-parse`
  - in-book search and TOC navigation
  - bookmarks, highlights, notes
- Reading data durability
  - progress and reading analytics
  - moved-book recovery via fingerprint matching
  - manual “merge moved/duplicate books” action in Settings

## Tech Stack

- Electron
- Node.js
- `epub2`
- `pdf-parse`
- `pdfjs-dist`

## Development

Requirements:
- Node.js 20+

Install:

```bash
npm install
```

Run in development:

```bash
npm start
```

Build Linux distributables:

```bash
npm run build
```

Create unpacked build:

```bash
npm run pack
```

## Arch Linux

This repo includes a `PKGBUILD` for local packaging:

```bash
makepkg -si
```

The installed launcher exports `ROSE_DATA_DIR` to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/RoseReader
```

`npm run start` and the packaged app share this same persistence location on Linux, so your reading progress, highlights, bookmarks, and notes are not split.

## Data Storage

App data is stored in Electron `userData` as:
- `rosereader-data.json`

It includes:
- libraries
- books and progress
- bookmarks/highlights/notes
- settings and reading stats

## Project Structure

- `main.js`: Electron main process, scanning/import, persistence, IPC
- `index.html`: renderer UI, styling, and client-side behavior
- `PKGBUILD`: packaging helper

## License

MIT
