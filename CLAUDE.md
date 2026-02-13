# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RoseReader is a desktop e-book reader built with Electron for EPUB, PDF, and TXT files. Features include infinite scrolling, library management with folders, custom themes, and progress tracking.

## Commands

```bash
npm install      # Install dependencies
npm start        # Run in development mode
npm run build    # Build for Linux (AppImage, pacman)
npm run pack     # Pack without creating installer
```

No test framework or linter is configured.

## Architecture

Standard Electron architecture with two processes:

- **Main Process (`main.js`)**: Backend handling file I/O, data persistence to `rosereader-data.json`, and IPC handlers. Uses `epub2` for EPUB parsing and `pdf-parse` for PDFs. PDF cover generation requires `pdftoppm` (poppler-utils).

- **Renderer Process (`index.html`)**: Single ~4600-line file containing all HTML, CSS, and vanilla JavaScript. No frontend framework.

### Key Patterns

- IPC: Frontend calls backend via `ipcRenderer.invoke('handler-name', ...args)`. All handlers defined in `main.js` via `ipcMain.handle()`.
- State: Backend `appData` object persisted to disk; frontend `state` object refreshed via `refreshState()`.
- Views: Single-page app toggling `#library-view` and `#reader-view` visibility.
- Theming: CSS variables (`--primary`, `--bg`, `--text`, etc.) with multiple app themes and accents.
- IDs: Books and libraries use `generateId()` (timestamp + random). Folder nodes use `hashPath()` for deterministic IDs.

### Adding New IPC Handlers

1. Add handler in `main.js`: `ipcMain.handle('handler-name', async (_, arg) => { ... })`
2. Call from renderer: `await ipcRenderer.invoke('handler-name', arg)`

## Data Structure

Application data stored in `rosereader-data.json` (user data directory):
- `books`: Book metadata keyed by ID (title, author, path, format, progress, libraryId)
- `libraries`: Array with `id`, `name`, `path`, and recursive `structure` (folders with `children` and `books` arrays)
- `settings`: User preferences with defaults in `defaultSettings`
- `stats`: Reading statistics (totalReadTime, booksRead)
- `analytics`: Daily reading time (`{ daily: { 'YYYY-MM-DD': seconds } }`)
- `bookmarks`, `highlights`, `notes`: Keyed by book ID
