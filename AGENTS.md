# Repository Guidelines

## Project Structure & Module Organization
The Electron entry point lives in `main.js`, which handles window lifecycle, library metadata, file hashing, and data migration logic. The renderer UI and styling are bundled inside `index.html`; keep shared UI fragments near their CSS/JS blocks for easy discovery. Generated dependencies sit under `node_modules/` and should not be edited manually. Release assets (screenshots) and the `PKGBUILD` helper illustrate platform packaging expectations. User configuration and analytics are persisted to `rosereader-data.json` within Electron's `app.getPath('userData')`; update migration helpers whenever the stored shape changes.

## Build, Test, and Development Commands
- `npm start`: launches the app in development with Electron, ideal for manual QA and logging.
- `npm run build`: produces Linux distributables via `electron-builder` (AppImage + pacman). Requires a clean `dist/` before uploading.
- `npm run pack`: creates an unpackaged directory build for quick smoke tests or installer debugging.
Use Node 20+ so the bundled Electron and `epub2` features behave consistently.

## Coding Style & Naming Conventions
Follow modern ES modules and `const`/`let` semantics, with 2-space indentation throughout HTML, CSS, and JS. Prefer descriptive camelCase for functions, variables, and IPC channels (`openLibraryView`, `readerTopBarVisible`). Keep renderer styles inlined inside `index.html` until a dedicated bundler is introduced; include brief comments ahead of complex layout blocks. Run Prettier locally if you add multi-file scripts to maintain spacing and quote consistency.

## Testing Guidelines
There is no automated test suite yet, so emphasize manual coverage: verify library import/export, EPUB/PDF parsing, and theme toggles with `npm start`. When fixing parsing or persistence code, add throwaway assertions near the change and remove them before merging. Document reproduction steps plus expected result in the PR description so reviewers can redo the scenario.

## Commit & Pull Request Guidelines
Git history is not bundled here, so default to Conventional Commits (`feat:`, `fix:`, `chore:`) with imperative summaries under 72 characters. Reference any tracked issue IDs in the body. PRs should include: concise motivation, screenshots or screen recordings for UI work (use `screenshot*.png` sizing as a reference), manual test notes, and callouts for data migrations that might affect existing `userData` stores.

## Configuration & Data Safety
Secrets are not stored in-repo; rely on Electron's environment variables for per-user overrides (e.g., `ROSE_DATA_DIR`). Always test migration paths on a backup of `rosereader-data.json` before shipping and keep the `saveData`/`loadData` helpers idempotent.
