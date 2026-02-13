# RoseReader Project Context

## Project Overview
RoseReader is a modern, aesthetically focused desktop e-book reader built with **Electron**. It emphasizes a "glassmorphism" design (Silk theme), infinite scrolling for continuous reading, and robust library management.

**Core Technologies:**
*   **Runtime:** Electron (Node.js + Chromium).
*   **Frontend:** Vanilla HTML, CSS, and JavaScript (no frameworks like React/Vue).
*   **Backend Logic:** Node.js (within Electron's Main process).
*   **Parsing:** `epub2` (EPUB), `pdf-parse` (PDF/Text).
*   **Persistence:** Custom JSON-based local storage.

## Architecture
The application adheres to the standard Electron multi-process architecture:

### 1. Main Process (`main.js`)
*   **Role:** The system "backend".
*   **Responsibilities:**
    *   **Window Management:** Creates and manages the `BrowserWindow`.
    *   **Data Persistence:** Loads/saves user data (libraries, books, settings) to `rosereader-data.json`.
    *   **File I/O:** Reading book files, parsing metadata, generating covers, and filesystem operations.
    *   **IPC Handlers:** Exposes native functionality to the renderer via `ipcMain.handle`.

### 2. Renderer Process (`index.html`)
*   **Role:** The user interface "frontend".
*   **Responsibilities:**
    *   **UI Rendering:** Dynamic HTML generation for the library grid, reader view, and settings.
    *   **State Management:** Maintains a local `state` object, synced from the main process.
    *   **Interactivity:** Handles clicks, scrolling, searching, and user inputs.
    *   **IPC Invocation:** Calls backend services using `ipcRenderer.invoke`.

## Key Files & Directories

*   **`main.js`**: The application entry point. Contains all "business logic" including book parsing (EPUB/PDF), cover generation, and data migration.
*   **`index.html`**: The monolithic frontend file. Contains the DOM structure, all CSS styling (including themes), and the client-side JavaScript logic.
*   **`package.json`**: Dependency management and build scripts.
*   **`PKGBUILD`**: Arch Linux packaging script.
*   **`rosereader-data.json`** (Runtime): Generated file in user data directory storing the database.

## Data Structure (`appData`)
The application state is stored in a single JSON object `appData` managed by `main.js`:

*   **`books`**: Dictionary mapping IDs to book objects (`{ id, title, path, progress, ... }`).
*   **`libraries`**: Array of library objects. Each library has a recursive `structure` node tree representing folders.
*   **`settings`**: User configuration (theme, font size, etc.).
*   **`stats`**: Global reading statistics (books read, total time).
*   **`analytics`**: Daily reading activity for insights.
*   **`bookmarks`, `highlights`, `notes`**: Dictionaries mapping book IDs to arrays of annotations.

## Build & Run

### Prerequisites
*   Node.js and npm.
*   Linux environment (for `PKGBUILD` or `electron-builder --linux`).

### Commands
*   **Development:**
    ```bash
    npm start  # Runs 'electron .'
    ```
*   **Build (Linux):**
    ```bash
    npm run build  # Runs 'electron-builder --linux' (Targets AppImage, pacman)
    ```
*   **Pack (Dir):**
    ```bash
    npm run pack   # Runs 'electron-builder --dir'
    ```

## Development Conventions

*   **Styling:**
    *   **Pure CSS:** No preprocessors (Sass/Less) or frameworks (Tailwind/Bootstrap).
    *   **Theming:** Heavy use of CSS variables (e.g., `--primary`, `--bg`, `--glass`) to support themes like "Silk", "Rose", and "Dark".
    *   **Responsiveness:** Fluid grid layouts and flexbox.

*   **Code Style:**
    *   **Vanilla JS:** Standard ES6+. DOM manipulation is done directly (`document.getElementById`, `innerHTML`).
    *   **Single File Frontend:** Most frontend logic resides within the `<script>` tag in `index.html`.
    *   **Async/Await:** Used extensively for IPC calls and file operations.

*   **IPC Pattern:**
    *   **Renderer:** `await ipcRenderer.invoke('action-name', args)`
    *   **Main:** `ipcMain.handle('action-name', async (event, args) => { ... })`
