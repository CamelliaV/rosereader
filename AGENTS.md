# Repository Guidelines

## Project Structure & Ownership
- `main.js`: Electron main process. Owns persistence (`rosereader-data.json`), migrations, directory scanning, file watchers, parsing bridges (EPUB/PDF/TXT), and IPC handlers.
- `index.html`: Renderer app (HTML/CSS/JS in one file). Owns library UI, reader UX, i18n rendering, settings panel, and modal flows.
- `tests/ui-logic.test.js`: fast regression checks for core UI logic.
- `build/`, `dist/`, `node_modules/`: generated/packaging artifacts; do not edit generated outputs by hand.

## Current App Model (Important)
- `All Books` is a virtual default scope (`selectedLibraryId: 'all'`), not a persisted physical library.
- Libraries can be:
  - `physical`: backed by a folder path on disk (`library.path` + folder `structure`).
  - `logical`: manual cross-folder membership, stored in `appData.libraryBookMap[libraryId]`.
- Folder behavior:
  - In a selected physical library: folder tree is mutable (create folder / move book).
  - In `All Books`: folder tree is synthesized from physical file paths and is read-only (filtering only).
- Duplicate handling:
  - Progress sync across duplicate identities happens continuously.
  - Record-level duplicate merge is available via recovery and migration paths.

## Persistence & Migration Conventions
- Keep `loadData`/`saveData` idempotent and backward compatible.
- Any schema change must be represented in migration helpers inside `main.js`.
- If a change affects library semantics, update both:
  - Migration logic in `main.js`.
  - Renderer assumptions in `index.html` (scope filtering, folder mode, counters).
- Respect `ROSE_DATA_DIR`; Linux defaults to XDG config path (`~/.config/RoseReader` when unset).

## Locale / i18n Conventions
- Supported app locales are `system`, `en`, `zh-CN`.
- Never add new user-facing copy in JS/HTML without i18n wiring:
  - Add keys to both `I18N.en` and `I18N['zh-CN']`.
  - Use `t(key)` or `tf(key, replacements)` in renderer logic.
  - Wire static labels/placeholders in `applyI18n()`.
- Treat **all** user-visible strings as localizable, including:
  - context menus, toasts, modal titles/descriptions/buttons,
  - dynamic template strings (for example, `Delete "{name}"?`),
  - `window.confirm`/`window.prompt` copy,
  - tooltip/title/aria text.
- Do not hardcode fallback English in UI flows. Use localized fallback keys (for example `untitled`, `libraryFallback`).
- After locale-related edits, run a sweep for regressions in `index.html`:
  - `showToast(...)`, `window.confirm(...)`, `window.prompt(...)`, context-menu labels, and modal button text.
- Prefer locale-aware formatting via existing helpers (for example, `formatDateTime` uses active locale).
- Keep locale-select labels and locale info row in sync with active/system locale resolution.

## Build, Run, Test
- `npm start`: run Electron app for manual QA.
- `npm run build`: create distributables.
- `npm run pack`: create unpackaged build.
- `node --check main.js`: quick syntax check for main process changes.
- `node tests/ui-logic.test.js`: run UI logic regression checks.

## Coding Style
- Use modern JS with `const`/`let`; avoid introducing globals.
- Keep 2-space indentation and existing inline-renderer style patterns.
- Reuse existing helpers before adding new ones (library type checks, folder tree traversal, i18n helpers).
- Prefer explicit guard clauses for IPC handlers and filesystem operations.

## Manual QA Checklist for Library/Locale Changes
- Import folder as physical library; verify folder tree, rescan, and watcher refresh.
- Confirm `All Books` shows synthesized physical directory tree in folder mode.
- Verify logical library membership add/remove still works.
- Run recovery merge and confirm duplicate books are actually deduped.
- Switch locale between `system`, `en`, `zh-CN`; verify settings labels, context menus, toasts, modal actions, and locale info update correctly.
