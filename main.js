const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const EPub = require('epub2').default;
const { PDFParse } = require('pdf-parse');

// Set app name and WM class for Wayland/Linux icon support
app.name = 'RoseReader';
if (process.platform === 'linux') {
  // Set the WM class to match the desktop file's StartupWMClass
  app.commandLine.appendSwitch('class', 'rosereader');
  app.setDesktopName('rosereader.desktop');
}

try {
  const { getPath: getPdfWorkerPath } = require('pdf-parse/worker');
  if (typeof getPdfWorkerPath === 'function') {
    const workerPath = getPdfWorkerPath();
    if (workerPath) PDFParse.setWorker(pathToFileURL(workerPath).toString());
  }
} catch (e) {
  console.warn('PDF worker setup failed, falling back to default', e?.message || e);
}

let mainWindow;
let currentEpub = null;
const libraryWatchers = new Map();
const LIBRARY_WATCH_DEBOUNCE_MS = 500;
const LIBRARY_WATCH_RESYNC_MS = 800;
const FILE_FINGERPRINT_SAMPLE_BYTES = 64 * 1024;
const LIBRARY_RESET_VERSION = 1;

// Performance: keep GPU accel enabled and reduce background throttling.
try {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
} catch (e) {}

const defaultSettings = {
  fontMode: 'book', // 'book' | 'system' | 'custom'
  fontFamily: '',
  fontSize: 18,
  lineHeight: 1.8,
  margin: 60,
  theme: 'light',
  appTheme: 'silk',
  appAccent: 'rose-gold',
  locale: 'system',
  bgColor: '#f8f1e3',
  textColor: '#4f321c',
  selectedLibraryId: 'all',
  librarySort: 'recent',
  librarySortDir: 'desc',
  pdfZoom: 120,
  readerMaxWidth: 1600,
  readerMargin: 48,
  tocWidth: 300,
  fitReaderWidth: true,
  markdownViewMode: 'rendered',
  markdownRawScope: 'full',
  readerTopBarVisible: true,
  selectionPopupEnabled: true,
  sidebarMode: 'libraries',
  cardDensity: 'comfortable',
  sidebarCollapsed: false,
  showHeroCover: true,
  showFirstCompletionInHall: true,
  appBgImageUrl: '',
  appBgOpacity: 0.14,
  appBgBlur: 12,
  tocHideDelay: 500
};

const defaultStats = {
  totalReadTime: 0,
  booksRead: 0
};

const defaultAnalytics = {
  daily: {}, // { 'YYYY-MM-DD': seconds }
  updatedAt: 0
};

let appData = {
  books: {},
  libraries: [],
  libraryBookMap: {},
  bookmarks: {},
  highlights: {},
  notes: {},
  settings: { ...defaultSettings },
  stats: { ...defaultStats },
  analytics: { ...defaultAnalytics }
};

function resolveRoseDataDir() {
  const customDirRaw = String(process.env.ROSE_DATA_DIR || '').trim();
  if (customDirRaw) {
    if (customDirRaw.startsWith('~/')) {
      return path.join(app.getPath('home'), customDirRaw.slice(2));
    }
    return path.resolve(customDirRaw);
  }

  if (process.platform === 'linux') {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME
      ? path.resolve(process.env.XDG_CONFIG_HOME)
      : path.join(app.getPath('home'), '.config');
    return path.join(xdgConfigHome, 'RoseReader');
  }

  return app.getPath('userData');
}

const roseDataDir = resolveRoseDataDir();
const dataPath = path.join(roseDataDir, 'rosereader-data.json');
const dataBackupPath = path.join(roseDataDir, 'rosereader-data-backup.json');

function ensureRoseDataDir() {
  try {
    fs.mkdirSync(roseDataDir, { recursive: true });
  } catch (e) {}
}

function loadData() {
  ensureRoseDataDir();
  try {
    if (fs.existsSync(dataPath)) {
      const saved = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      appData = { ...appData, ...saved };
      appData.settings = { ...defaultSettings, ...(saved.settings || {}) };
      appData.stats = { ...defaultStats, ...(saved.stats || {}) };
      appData.analytics = { ...defaultAnalytics, ...(saved.analytics || {}) };
      if (migrateData()) saveData();
    } else if (fs.existsSync(dataBackupPath)) {
      console.log('Main data not found, restoring from backup');
      const saved = JSON.parse(fs.readFileSync(dataBackupPath, 'utf8'));
      appData = { ...appData, ...saved };
      appData.settings = { ...defaultSettings, ...(saved.settings || {}) };
      appData.stats = { ...defaultStats, ...(saved.stats || {}) };
      appData.analytics = { ...defaultAnalytics, ...(saved.analytics || {}) };
      migrateData();
      saveData();
    }
  } catch (e) {
    console.error('Load error:', e);
    try {
      if (fs.existsSync(dataBackupPath)) {
        const saved = JSON.parse(fs.readFileSync(dataBackupPath, 'utf8'));
        appData = { ...appData, ...saved };
        appData.settings = { ...defaultSettings, ...(saved.settings || {}) };
        appData.stats = { ...defaultStats, ...(saved.stats || {}) };
        appData.analytics = { ...defaultAnalytics, ...(saved.analytics || {}) };
        migrateData();
        saveData();
      }
    } catch (backupError) {
      console.error('Backup restore failed:', backupError);
    }
  }
}

function saveData() {
  ensureRoseDataDir();
  try {
    const data = JSON.stringify(appData, null, 2);
    fs.writeFileSync(dataPath, data);
    fs.writeFileSync(dataBackupPath, data);
  } catch (e) { console.error('Save error:', e); }
}

function notifyLibrariesAutoRefreshed(payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('libraries-auto-refreshed', payload);
    } catch (e) {}
  }
}

function exportData(filePath) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(appData, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function importData(filePath) {
  try {
    const imported = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    appData = { ...appData, ...imported };
    appData.settings = { ...defaultSettings, ...(imported.settings || {}) };
    appData.stats = { ...defaultStats, ...(imported.stats || {}) };
    appData.analytics = { ...defaultAnalytics, ...(imported.analytics || {}) };
    migrateData();
    saveData();
    restartAllLibraryWatchers();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function hashPath(p) {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function migrateData() {
  let changed = false;

  migrateLegacyBookIds();
  appData.settings = { ...defaultSettings, ...(appData.settings || {}) };

  if (resetLibrariesToAllBooksIfNeeded()) changed = true;
  ensureLibraryTypes();
  ensureLibraryBookMap();
  ensureLibraryNodeIds();
  if (ensureBookDefaults()) changed = true;
  if (clearStaleBookLibraryOwnership()) changed = true;

  if (appData.settings.selectedLibraryId !== 'all') changed = true;
  appData.settings.selectedLibraryId = 'all';
  const markedMissing = markBooksMissingForUnavailableLibraries(true);
  const mergedCount = recoverMovedBookProgress();
  const syncedCount = synchronizeDuplicateBookProgress();
  const dedupedCount = mergeDuplicateBooks();
  ensureLibraryBookMap();

  return changed || markedMissing > 0 || mergedCount > 0 || syncedCount > 0 || dedupedCount > 0;
}

function resetLibrariesToAllBooksIfNeeded() {
  const currentVersion = Number(appData.settings?.libraryResetVersion || 0);
  if (currentVersion >= LIBRARY_RESET_VERSION) return false;

  for (const libraryId of [...libraryWatchers.keys()]) {
    stopLibraryWatcher(libraryId);
  }

  appData.libraries = [];
  appData.libraryBookMap = {};

  for (const book of Object.values(appData.books || {})) {
    if (!book || !book.libraryId) continue;
    delete book.libraryId;
  }

  appData.settings.selectedLibraryId = 'all';
  if (appData.settings.sidebarMode === 'folders') appData.settings.sidebarMode = 'libraries';
  appData.settings.libraryResetVersion = LIBRARY_RESET_VERSION;
  return true;
}

function clearStaleBookLibraryOwnership() {
  const libraryIds = new Set((appData.libraries || []).map(lib => String(lib?.id || '')).filter(Boolean));
  let changed = false;

  for (const book of Object.values(appData.books || {})) {
    if (!book?.libraryId) continue;
    if (libraryIds.has(String(book.libraryId))) continue;
    delete book.libraryId;
    changed = true;
  }

  return changed;
}

function isPhysicalLibrary(library) {
  if (!library) return false;
  if (library.type === 'physical') return true;
  if (library.type === 'logical') return false;
  return !!library.path;
}

function isLogicalLibrary(library) {
  return !!library && !isPhysicalLibrary(library);
}

function collectBookIdsFromNode(node, outSet = new Set()) {
  if (!node) return outSet;
  for (const id of node.books || []) outSet.add(String(id || ''));
  for (const child of node.children || []) collectBookIdsFromNode(child, outSet);
  return outSet;
}

function ensureLibraryTypes() {
  appData.libraries = Array.isArray(appData.libraries) ? appData.libraries : [];
  for (const library of appData.libraries) {
    if (!library) continue;
    if (library.path) {
      library.type = 'physical';
      continue;
    }
    library.type = 'logical';
  }
}

function ensureLibraryBookMap() {
  if (!appData.libraryBookMap || typeof appData.libraryBookMap !== 'object' || Array.isArray(appData.libraryBookMap)) {
    appData.libraryBookMap = {};
  }

  const map = appData.libraryBookMap;
  const existingBookIds = new Set(Object.keys(appData.books || {}));
  const libraryIds = new Set((appData.libraries || []).map(lib => String(lib?.id || '')).filter(Boolean));

  for (const key of Object.keys(map)) {
    if (!libraryIds.has(key)) delete map[key];
  }

  const sanitizeIds = (ids) => {
    const out = [];
    const seen = new Set();
    for (const rawId of ids || []) {
      const id = String(rawId || '');
      if (!id || !existingBookIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  for (const [libraryId, ids] of Object.entries(map)) {
    map[libraryId] = sanitizeIds(Array.isArray(ids) ? ids : []);
  }

  for (const library of appData.libraries || []) {
    if (!library?.id) continue;
    if (!isLogicalLibrary(library)) {
      if (map[library.id]) delete map[library.id];
      continue;
    }

    let ids = Array.isArray(map[library.id]) ? map[library.id] : null;
    if ((!ids || ids.length === 0) && library.structure) {
      ids = [...collectBookIdsFromNode(library.structure)];
    }
    const legacyOwned = Object.values(appData.books || {})
      .filter(book => String(book?.libraryId || '') === String(library.id))
      .map(book => String(book.id || ''))
      .filter(Boolean);
    if (legacyOwned.length > 0) {
      ids = [...(ids || []), ...legacyOwned];
    }
    map[library.id] = sanitizeIds(ids || []);
  }
}

function replaceBookIdInLogicalLibraries(sourceBookId, targetBookId = null) {
  const sourceId = String(sourceBookId || '');
  const targetId = targetBookId ? String(targetBookId) : '';
  if (!sourceId) return false;

  ensureLibraryBookMap();
  let changed = false;

  for (const library of appData.libraries || []) {
    if (!isLogicalLibrary(library) || !library?.id) continue;

    const current = Array.isArray(appData.libraryBookMap[library.id]) ? appData.libraryBookMap[library.id] : [];
    if (current.length === 0) continue;

    let touched = false;
    const seen = new Set();
    const next = [];

    for (const rawId of current) {
      let id = String(rawId || '');
      if (!id) continue;
      if (id === sourceId) {
        touched = true;
        id = targetId;
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }

    if (touched || next.length !== current.length) {
      appData.libraryBookMap[library.id] = next;
      changed = true;
    }
  }

  return changed;
}

function normalizeIdentityText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeLooseIdentityText(value) {
  let text = normalizeIdentityText(value);
  if (!text) return '';
  text = text.replace(/\[[^\]]*]|\([^)]*\)|\{[^}]*}/g, ' ');
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function normalizeBaseName(filePath) {
  if (!filePath) return '';
  return normalizeIdentityText(path.basename(filePath, path.extname(filePath)));
}

function normalizeBookPathKey(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  try {
    const resolved = path.resolve(raw);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch (e) {
    return process.platform === 'win32' ? raw.toLowerCase() : raw;
  }
}

function getBookDuplicateMergeKey(book) {
  if (!book) return '';
  const fingerprint = String(book.fileFingerprint || '').trim();
  if (fingerprint) return `fp|${fingerprint}`;
  const pathKey = normalizeBookPathKey(book.path);
  if (pathKey) return `path|${pathKey}`;
  return '';
}

function getBookExactMetaMergeKey(book) {
  if (!book) return '';
  const formatKey = normalizeIdentityText(book.format || '');
  const titleKey = normalizeIdentityText(book.title);
  const authorKey = normalizeIdentityText(book.author || 'unknown');
  if (!formatKey || !titleKey || !authorKey) return '';
  return `meta|${formatKey}|${titleKey}|${authorKey}`;
}

function getBookLooseMetaMergeKey(book) {
  if (!book) return '';
  const formatKey = normalizeIdentityText(book.format || '');
  const titleKey = normalizeLooseIdentityText(book.title);
  const authorRaw = normalizeLooseIdentityText(book.author || '');
  const authorKey = authorRaw || 'unknown';
  if (!formatKey || !titleKey) return '';
  return `loose|${formatKey}|${titleKey}|${authorKey}`;
}

function getBookIdentityKey(book) {
  if (!book) return '';

  const fingerprint = String(book.fileFingerprint || '').trim();
  if (fingerprint) return `fp|${fingerprint}`;

  const formatKey = normalizeIdentityText(book.format || '');
  const titleKey = normalizeIdentityText(book.title);
  const authorKey = normalizeIdentityText(book.author || 'unknown');

  if (titleKey && authorKey) return `meta|${formatKey}|${titleKey}|${authorKey}`;
  return '';
}

function getBookRecencyStamp(book) {
  if (!book) return 0;
  return Math.max(
    Number(book.lastRead || 0),
    Number(book?.epubLocation?.updatedAt || 0)
  );
}

function pickMostRecentBookEntry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  let best = entries[0];
  let bestStamp = getBookRecencyStamp(best.book);

  for (let i = 1; i < entries.length; i++) {
    const candidate = entries[i];
    const stamp = getBookRecencyStamp(candidate.book);
    if (stamp > bestStamp) {
      best = candidate;
      bestStamp = stamp;
      continue;
    }
    if (stamp < bestStamp) continue;

    const candidateProgress = Number(candidate?.book?.progress || 0);
    const bestProgress = Number(best?.book?.progress || 0);
    if (candidateProgress > bestProgress) {
      best = candidate;
      bestStamp = stamp;
    }
  }

  return best;
}

function pickEarliestPositiveTimestamp(values) {
  let earliest = 0;
  for (const value of values) {
    const n = Number(value || 0);
    if (n <= 0) continue;
    if (earliest <= 0 || n < earliest) earliest = n;
  }
  return earliest;
}

function isSameEpubLocation(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return String(left.href || '') === String(right.href || '')
    && Number(left.ratio || 0) === Number(right.ratio || 0)
    && String(left.anchor || '') === String(right.anchor || '')
    && Number(left.anchorDelta || 0) === Number(right.anchorDelta || 0)
    && Number(left.updatedAt || 0) === Number(right.updatedAt || 0);
}

function synchronizeDuplicateBookProgressForIds(bookIds) {
  const ids = [...new Set((bookIds || []).map(id => String(id || '')).filter(Boolean))];
  if (ids.length < 2) return false;

  const entries = ids
    .map(id => ({ id, book: appData.books?.[id] }))
    .filter(entry => !!entry.book);
  if (entries.length < 2) return false;

  const source = pickMostRecentBookEntry(entries);
  if (!source?.book) return false;
  const sourceBook = source.book;

  const progress = Math.max(0, Math.min(1, Number(sourceBook.progress || 0)));
  const progressChapter = Math.max(0, Number(sourceBook.progressChapter || 0));
  const progressOffset = Math.max(0, Number(sourceBook.progressOffset || 0));
  const lastRead = Math.max(...entries.map(entry => Number(entry.book?.lastRead || 0)));
  const timeSpent = Math.max(...entries.map(entry => Number(entry.book?.timeSpent || 0)));
  const firstCompletedAt = pickEarliestPositiveTimestamp(entries.map(entry => entry.book?.firstCompletedAt));
  const completedAt = pickEarliestPositiveTimestamp(entries.map(entry => entry.book?.completedAt));

  let location = null;
  let locationStamp = -1;
  for (const entry of entries) {
    const loc = entry.book?.epubLocation;
    if (!loc || typeof loc !== 'object') continue;
    const stamp = Number(loc.updatedAt || 0);
    if (!location || stamp > locationStamp) {
      location = { ...loc };
      locationStamp = stamp;
    }
  }

  let changed = false;
  for (const entry of entries) {
    const book = entry.book;
    if (!book) continue;

    if (Number(book.progress || 0) !== progress) {
      book.progress = progress;
      changed = true;
    }
    if (Number(book.progressChapter || 0) !== progressChapter) {
      book.progressChapter = progressChapter;
      changed = true;
    }
    if (Number(book.progressOffset || 0) !== progressOffset) {
      book.progressOffset = progressOffset;
      changed = true;
    }
    if (lastRead > 0 && Number(book.lastRead || 0) !== lastRead) {
      book.lastRead = lastRead;
      changed = true;
    }
    if (timeSpent > 0 && Number(book.timeSpent || 0) !== timeSpent) {
      book.timeSpent = timeSpent;
      changed = true;
    }
    if (firstCompletedAt > 0 && Number(book.firstCompletedAt || 0) !== firstCompletedAt) {
      book.firstCompletedAt = firstCompletedAt;
      changed = true;
    }
    if (completedAt > 0 && Number(book.completedAt || 0) !== completedAt) {
      book.completedAt = completedAt;
      changed = true;
    }
    if (location && !isSameEpubLocation(book.epubLocation, location)) {
      book.epubLocation = { ...location };
      changed = true;
    }
  }

  return changed;
}

function synchronizeDuplicateBookProgress(bookIds = null) {
  const booksById = appData.books || {};
  const idsByKey = new Map();

  for (const [bookId, book] of Object.entries(booksById)) {
    const key = getBookIdentityKey(book);
    if (!key) continue;
    if (!idsByKey.has(key)) idsByKey.set(key, []);
    idsByKey.get(key).push(bookId);
  }

  const keysToSync = new Set();
  if (Array.isArray(bookIds) && bookIds.length > 0) {
    for (const bookId of bookIds) {
      const key = getBookIdentityKey(booksById[bookId]);
      if (key) keysToSync.add(key);
    }
  } else {
    for (const key of idsByKey.keys()) keysToSync.add(key);
  }

  let changedGroups = 0;
  for (const key of keysToSync) {
    const ids = idsByKey.get(key) || [];
    if (ids.length < 2) continue;
    if (synchronizeDuplicateBookProgressForIds(ids)) changedGroups += 1;
  }

  if (changedGroups > 0) {
    console.log(`Synchronized duplicate reading progress for ${changedGroups} book group(s)`);
  }
  return changedGroups;
}

function isExistingFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch (e) {
    return false;
  }
}

function escapeHtmlText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodeUtf16Be(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const evenLength = bytes.length - (bytes.length % 2);
  if (evenLength <= 0) return '';
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return swapped.toString('utf16le');
}

function readTextFileBestEffort(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0) return '';

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.slice(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.slice(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16Be(bytes.slice(2));
  }

  const sampleLen = Math.min(bytes.length, 4096);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenZero += 1;
    else oddZero += 1;
  }

  const zeroThreshold = Math.max(24, Math.floor(sampleLen * 0.12));
  if (oddZero >= zeroThreshold && oddZero > evenZero * 2) return bytes.toString('utf16le');
  if (evenZero >= zeroThreshold && evenZero > oddZero * 2) return decodeUtf16Be(bytes);

  return bytes.toString('utf8');
}

function normalizeTxtChapterTitle(line) {
  let title = String(line || '').trim();
  if (!title) return '';
  title = title.replace(/^#{1,6}\s+/, '').trim();
  title = title.replace(/\s+/g, ' ').trim();
  if (title.length > 120) title = `${title.slice(0, 117).trimEnd()}...`;
  return title;
}

function detectTxtChapterMarkers(lines) {
  const markers = [];
  const patterns = [
    /^#{1,6}\s+\S+/,
    /^(?:chapter|chap\.|section|part|book)\s+[0-9ivxlcdm]+(?:\b|[\s:.\-])/i,
    /^第[0-9一二三四五六七八九十百千零〇两]+[章节回卷部篇](?:\s|$)/
  ];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = String(lines[i] || '').trim();
    if (!trimmed || trimmed.length > 140) continue;

    let matched = patterns.some(pattern => pattern.test(trimmed));
    if (!matched) {
      const nextBlank = String(lines[i + 1] || '').trim() === '';
      const upperLike = /^[A-Z0-9][A-Z0-9 \-:'",.!?]{2,80}$/.test(trimmed);
      if (upperLike && nextBlank) matched = true;
    }
    if (!matched) continue;

    const title = normalizeTxtChapterTitle(trimmed);
    if (!title) continue;
    if (markers.length > 0 && (i - markers[markers.length - 1].lineIndex) <= 1) continue;
    markers.push({ lineIndex: i, title });
  }

  return markers;
}

function buildTxtContentWithToc(text, fallbackTitle = 'Text') {
  const normalizedText = String(text || '').replace(/\r\n?/g, '\n');
  const lines = normalizedText.split('\n');
  const markers = detectTxtChapterMarkers(lines);
  const safeFallbackTitle = String(fallbackTitle || '').trim() || 'Text';

  const buildSingle = (title) => ({
    chapters: [`<pre style="white-space:pre-wrap">${escapeHtmlText(normalizedText)}</pre>`],
    toc: [{ title: title || safeFallbackTitle, href: 'txt-chapter-1', chapterIndex: 0, level: 0 }],
    chapterIds: ['txt-chapter-1'],
    rawChapters: [normalizedText]
  });

  if (markers.length < 2) {
    return buildSingle(markers[0]?.title || safeFallbackTitle);
  }

  const boundaries = markers.slice();
  const hasPreface = boundaries[0].lineIndex > 0
    && lines.slice(0, boundaries[0].lineIndex).some(line => String(line || '').trim());
  if (hasPreface) boundaries.unshift({ lineIndex: 0, title: 'Introduction' });

  const chapters = [];
  const toc = [];
  const chapterIds = [];
  const rawChapters = [];

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].lineIndex;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].lineIndex : lines.length;
    const chunk = lines.slice(start, end).join('\n').trim();
    if (!chunk) continue;

    const chapterIndex = chapters.length;
    const chapterId = `txt-chapter-${chapterIndex + 1}`;
    const title = boundaries[i].title || `Chapter ${chapterIndex + 1}`;

    chapters.push(`<pre style="white-space:pre-wrap">${escapeHtmlText(chunk)}</pre>`);
    toc.push({ title, href: chapterId, chapterIndex, level: 0 });
    chapterIds.push(chapterId);
    rawChapters.push(chunk);
  }

  if (!chapters.length) {
    return buildSingle(markers[0]?.title || safeFallbackTitle);
  }

  return { chapters, toc, chapterIds, rawChapters };
}

function splitMarkdownFrontMatter(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { body: normalized, data: {} };

  const data = {};
  let parsedFields = 0;
  for (const rawLine of match[1].split('\n')) {
    const line = String(rawLine || '');
    const fieldMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (!fieldMatch) continue;
    let value = String(fieldMatch[2] || '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[String(fieldMatch[1] || '').toLowerCase()] = value;
    parsedFields += 1;
  }

  if (parsedFields <= 0) return { body: normalized, data: {} };
  return { body: normalized.slice(match[0].length), data };
}

function normalizeMarkdownTitle(raw) {
  let title = String(raw || '').trim();
  if (!title) return '';
  title = title.replace(/\s+#+\s*$/, '').trim();
  title = title.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  title = title.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  title = title.replace(/[`*_~]/g, '');
  title = title.replace(/\s+/g, ' ').trim();
  if (title.length > 140) title = `${title.slice(0, 137).trimEnd()}...`;
  return title;
}

function slugifyMarkdownTitle(rawTitle) {
  const normalized = normalizeMarkdownTitle(rawTitle)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return normalized || 'section';
}

function sanitizeMarkdownHref(rawHref) {
  const href = String(rawHref || '').trim();
  if (!href) return '';
  const lowered = href.toLowerCase();
  if (lowered.startsWith('javascript:')) return '';
  if (lowered.startsWith('vbscript:')) return '';
  if (lowered.startsWith('data:')) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^(https?:|mailto:|tel:)/i.test(href)) return '';
  return href;
}

function resolveMarkdownImageSrc(bookPath, rawSrc) {
  const source = sanitizeMarkdownHref(rawSrc);
  if (!source) return '';
  if (/^(https?:|file:|data:|blob:)/i.test(source)) return source;
  if (source.startsWith('#')) return '';
  if (!bookPath) return source;

  const fileParts = source.split('#');
  const pathAndQuery = fileParts[0] || '';
  const hashPart = fileParts[1] ? `#${fileParts.slice(1).join('#')}` : '';
  const querySplit = pathAndQuery.split('?');
  const relPath = querySplit[0] || '';
  const queryPart = querySplit[1] ? `?${querySplit.slice(1).join('?')}` : '';
  if (!relPath) return '';

  const absPath = path.resolve(path.dirname(bookPath), relPath);
  return `${pathToFileURL(absPath).toString()}${queryPart}${hashPart}`;
}

function renderMarkdownInline(text, bookPath) {
  const codeTokens = [];
  const token = (idx) => `@@MD_CODE_${idx}@@`;

  let source = String(text || '');
  source = source.replace(/`([^`\n]+)`/g, (_, code) => {
    const key = token(codeTokens.length);
    codeTokens.push(`<code>${escapeHtmlText(code)}</code>`);
    return key;
  });

  let escaped = escapeHtmlText(source);

  escaped = escaped.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, altRaw, srcRaw, titleRaw = '') => {
    const src = resolveMarkdownImageSrc(bookPath, srcRaw);
    if (!src) return '';
    const alt = escapeHtmlText(altRaw || '');
    const titleAttr = titleRaw ? ` title="${escapeHtmlText(titleRaw)}"` : '';
    return `<img src="${escapeHtmlText(src)}" alt="${alt}" loading="lazy"${titleAttr}>`;
  });

  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, labelRaw, hrefRaw, titleRaw = '') => {
    const safeHref = sanitizeMarkdownHref(hrefRaw) || '#';
    const titleAttr = titleRaw ? ` title="${escapeHtmlText(titleRaw)}"` : '';
    return `<a href="${escapeHtmlText(safeHref)}"${titleAttr}>${labelRaw}</a>`;
  });

  escaped = escaped.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (_, hrefRaw) => {
    const safeHref = sanitizeMarkdownHref(hrefRaw);
    if (!safeHref) return '';
    const href = escapeHtmlText(safeHref);
    return `<a href="${href}">${href}</a>`;
  });

  escaped = escaped.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  for (let i = 0; i < codeTokens.length; i++) {
    escaped = escaped.replaceAll(token(i), codeTokens[i]);
  }

  return escaped;
}

function buildMarkdownContentWithToc(text, fallbackTitle = 'Text', bookPath = '') {
  const normalizedText = String(text || '').replace(/\r\n?/g, '\n');
  const { body: bodyText, data: frontMatter } = splitMarkdownFrontMatter(normalizedText);
  const safeFallbackTitle = normalizeMarkdownTitle(frontMatter?.title || fallbackTitle) || 'Text';
  const lines = [];
  for (const rawLine of bodyText.split('\n')) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    const looksLikeCompressedTable = trimmed.startsWith('|')
      && line.includes('||')
      && /\|[-:\s]{3,}\|/.test(line);
    if (!looksLikeCompressedTable) {
      lines.push(line);
      continue;
    }

    const segments = line.split('||').map(segment => String(segment || '').trim()).filter(Boolean);
    if (segments.length >= 2) lines.push(...segments);
    else lines.push(line);
  }
  const chapterIds = ['md-chapter-1'];
  const rawChapters = [bodyText];
  const toc = [];
  const htmlParts = [];
  const usedSlugs = new Set();

  let paragraphLines = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let inCodeFence = false;
  let codeFenceMarker = '```';
  let codeLang = '';
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const merged = paragraphLines.map(line => String(line || '').trim()).filter(Boolean).join(' ');
    if (merged) htmlParts.push(`<p>${renderMarkdownInline(merged, bookPath)}</p>`);
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) {
      listType = null;
      listItems = [];
      return;
    }
    const tag = listType === 'ol' ? 'ol' : 'ul';
    htmlParts.push(`<${tag}>${listItems.map(item => `<li>${item}</li>`).join('')}</${tag}>`);
    listType = null;
    listItems = [];
  };

  const flushQuote = () => {
    if (!quoteLines.length) return;
    const quoteHtml = quoteLines
      .map(line => String(line || '').trim())
      .filter(Boolean)
      .map(line => renderMarkdownInline(line, bookPath))
      .join('<br>');
    if (quoteHtml) htmlParts.push(`<blockquote><p>${quoteHtml}</p></blockquote>`);
    quoteLines = [];
  };

  const flushCode = () => {
    const classAttr = codeLang ? ` class="language-${escapeHtmlText(codeLang)}"` : '';
    htmlParts.push(`<pre class="md-code-block"><code${classAttr}>${escapeHtmlText(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
    codeLang = '';
  };

  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  const splitMarkdownTableRow = (rawLine) => {
    let row = String(rawLine || '').trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|')) row = row.slice(0, -1);
    return row.split('|').map(cell => String(cell || '').trim());
  };

  const isMarkdownTableSeparator = (rawLine) => {
    const cells = splitMarkdownTableRow(rawLine);
    if (cells.length < 2) return false;
    return cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
  };

  const parseMarkdownTableAlignments = (separatorLine, columnCount) => {
    const cells = splitMarkdownTableRow(separatorLine);
    const alignments = [];
    for (let i = 0; i < columnCount; i += 1) {
      const marker = String(cells[i] || '').replace(/\s+/g, '');
      if (marker.startsWith(':') && marker.endsWith(':')) alignments.push('center');
      else if (marker.endsWith(':')) alignments.push('right');
      else alignments.push('left');
    }
    return alignments;
  };

  const buildMarkdownTableHtml = (headerRow, separatorRow, bodyRows) => {
    const columnCount = Math.max(2, headerRow.length, ...bodyRows.map(row => row.length));
    const normalizeRow = (row) => Array.from({ length: columnCount }, (_, idx) => String(row[idx] || '').trim());
    const alignments = parseMarkdownTableAlignments(separatorRow, columnCount);
    const headerCells = normalizeRow(headerRow);
    const bodyCells = bodyRows.map(normalizeRow);

    const theadHtml = `<tr>${headerCells.map((cell, idx) => {
      const align = alignments[idx] || 'left';
      const content = cell ? renderMarkdownInline(cell, bookPath) : '&nbsp;';
      return `<th style="text-align:${align}">${content}</th>`;
    }).join('')}</tr>`;

    const tbodyHtml = bodyCells.map((row) => {
      const cells = row.map((cell, idx) => {
        const align = alignments[idx] || 'left';
        const content = cell ? renderMarkdownInline(cell, bookPath) : '&nbsp;';
        return `<td style="text-align:${align}">${content}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    return `<div class="md-table-wrap"><table class="md-table"><thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table></div>`;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = String(lines[lineIndex] || '');

    if (inCodeFence) {
      const closeFence = new RegExp(`^\\s*${codeFenceMarker}\\s*$`);
      if (closeFence.test(line)) {
        flushCode();
        inCodeFence = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fenceMatch = line.match(/^\s*(```+|~~~+)\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fenceMatch) {
      flushBlocks();
      inCodeFence = true;
      codeFenceMarker = String(fenceMatch[1] || '```');
      codeLang = String(fenceMatch[2] || '').trim();
      codeLines = [];
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushBlocks();
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      flushBlocks();
      const level = Math.max(1, Math.min(6, headingMatch[1].length));
      const headingRaw = String(headingMatch[2] || '').replace(/\s+#+\s*$/, '').trim();
      const headingTitle = normalizeMarkdownTitle(headingRaw) || `${safeFallbackTitle} ${toc.length + 1}`;
      const slugBase = slugifyMarkdownTitle(headingTitle);
      let slug = slugBase;
      let serial = 2;
      while (usedSlugs.has(slug)) {
        slug = `${slugBase}-${serial}`;
        serial += 1;
      }
      usedSlugs.add(slug);

      htmlParts.push(`<h${level} id="${escapeHtmlText(slug)}">${renderMarkdownInline(headingRaw, bookPath)}</h${level}>`);
      toc.push({ title: headingTitle, href: `md-chapter-1#${slug}`, chapterIndex: 0, level: level - 1 });
      continue;
    }

    const nextLine = String(lines[lineIndex + 1] || '');
    const headerCells = line.includes('|') ? splitMarkdownTableRow(line) : [];
    if (headerCells.length >= 2 && isMarkdownTableSeparator(nextLine)) {
      flushBlocks();

      const bodyRows = [];
      let cursor = lineIndex + 2;
      while (cursor < lines.length) {
        const rowLine = String(lines[cursor] || '');
        const rowTrimmed = rowLine.trim();
        if (!rowTrimmed) break;
        if (!rowLine.includes('|')) break;
        if (isMarkdownTableSeparator(rowLine)) break;
        bodyRows.push(splitMarkdownTableRow(rowLine));
        cursor += 1;
      }

      htmlParts.push(buildMarkdownTableHtml(headerCells, nextLine, bodyRows));
      lineIndex = cursor - 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushBlocks();
      htmlParts.push('<hr>');
      continue;
    }

    const quoteMatch = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1] || '');
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-+*]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      flushQuote();
      const nextType = orderedMatch ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(renderMarkdownInline(orderedMatch ? orderedMatch[1] : unorderedMatch[1], bookPath));
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(trimmed);
  }

  if (inCodeFence) {
    flushCode();
    inCodeFence = false;
  }

  flushBlocks();

  if (!toc.length) {
    toc.push({ title: safeFallbackTitle, href: 'md-chapter-1#overview', chapterIndex: 0, level: 0 });
    htmlParts.unshift(`<h1 id="overview">${escapeHtmlText(safeFallbackTitle)}</h1>`);
  }

  const chapterHtml = `<article class="md-article">${htmlParts.join('\n')}</article>`;
  return { chapters: [chapterHtml], toc, chapterIds, rawChapters };
}

async function getMarkdownMetadata(filePath) {
  const fallbackTitle = path.basename(filePath, path.extname(filePath));
  try {
    const text = readTextFileBestEffort(filePath);
    const { body, data } = splitMarkdownFrontMatter(text);
    const frontMatterTitle = normalizeMarkdownTitle(data?.title || '');
    const frontMatterAuthor = String(data?.author || '').trim();
    if (frontMatterTitle || frontMatterAuthor) {
      return {
        title: frontMatterTitle || fallbackTitle,
        author: frontMatterAuthor || 'Unknown'
      };
    }

    const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
    for (const rawLine of lines) {
      const heading = rawLine.match(/^\s{0,3}#\s+(.+?)\s*$/);
      if (!heading) continue;
      const title = normalizeMarkdownTitle(heading[1]);
      if (title) return { title, author: 'Unknown' };
    }
  } catch (e) {}
  return { title: fallbackTitle, author: 'Unknown' };
}

function collectionCountForBook(bookId) {
  const bookmarks = Array.isArray(appData.bookmarks?.[bookId]) ? appData.bookmarks[bookId].length : 0;
  const highlights = Array.isArray(appData.highlights?.[bookId]) ? appData.highlights[bookId].length : 0;
  const notes = Array.isArray(appData.notes?.[bookId]) ? appData.notes[bookId].length : 0;
  return bookmarks + highlights + notes;
}

function hasMeaningfulReadingState(bookId, book) {
  if (!book) return false;
  if (Number(book.progress || 0) > 0.01) return true;
  if (Number(book.timeSpent || 0) > 0) return true;
  if (Number(book.lastRead || 0) > 0) return true;
  if (Number(book.firstCompletedAt || 0) > 0 || Number(book.completedAt || 0) > 0) return true;
  if (collectionCountForBook(bookId) > 0) return true;
  return false;
}

function mergeBookCollection(targetBookId, sourceBookId, collectionKey) {
  const collection = appData[collectionKey] || {};
  const targetList = Array.isArray(collection[targetBookId]) ? collection[targetBookId] : [];
  const sourceList = Array.isArray(collection[sourceBookId]) ? collection[sourceBookId] : [];

  if (sourceList.length === 0) {
    if (collection[sourceBookId]) delete collection[sourceBookId];
    appData[collectionKey] = collection;
    return;
  }

  const merged = [...targetList, ...sourceList].sort((left, right) => {
    const leftTs = Number(left?.timestamp || left?.updatedAt || 0);
    const rightTs = Number(right?.timestamp || right?.updatedAt || 0);
    return leftTs - rightTs;
  });

  const seen = new Set();
  const deduped = [];
  for (const item of merged) {
    const itemId = item?.id ? String(item.id) : '';
    if (itemId && seen.has(itemId)) continue;
    if (itemId) seen.add(itemId);
    deduped.push(item);
  }

  collection[targetBookId] = deduped;
  if (collection[sourceBookId]) delete collection[sourceBookId];
  appData[collectionKey] = collection;
}

function mergeBookState(targetBook, sourceBook) {
  const sourceRecency = getBookRecencyStamp(sourceBook);
  const targetRecency = getBookRecencyStamp(targetBook);
  if (sourceRecency >= targetRecency) {
    targetBook.progress = Math.max(0, Math.min(1, Number(sourceBook.progress || 0)));
    targetBook.progressChapter = Math.max(0, Number(sourceBook.progressChapter || 0));
    targetBook.progressOffset = Math.max(0, Number(sourceBook.progressOffset || 0));
  } else {
    targetBook.progress = Math.max(0, Math.min(1, Number(targetBook.progress || 0)));
    targetBook.progressChapter = Math.max(0, Number(targetBook.progressChapter || 0));
    targetBook.progressOffset = Math.max(0, Number(targetBook.progressOffset || 0));
  }
  targetBook.timeSpent = Number(targetBook.timeSpent || 0) + Number(sourceBook.timeSpent || 0);
  targetBook.lastRead = Math.max(Number(targetBook.lastRead || 0), Number(sourceBook.lastRead || 0));

  const sourceFirstCompletedAt = Number(sourceBook.firstCompletedAt || 0);
  const targetFirstCompletedAt = Number(targetBook.firstCompletedAt || 0);
  if (sourceFirstCompletedAt > 0 && (targetFirstCompletedAt <= 0 || sourceFirstCompletedAt < targetFirstCompletedAt)) {
    targetBook.firstCompletedAt = sourceFirstCompletedAt;
  }

  const sourceCompletedAt = Number(sourceBook.completedAt || 0);
  const targetCompletedAt = Number(targetBook.completedAt || 0);
  if (sourceCompletedAt > 0 && (targetCompletedAt <= 0 || sourceCompletedAt < targetCompletedAt)) {
    targetBook.completedAt = sourceCompletedAt;
  }

  const sourceEpubUpdated = Number(sourceBook?.epubLocation?.updatedAt || 0);
  const targetEpubUpdated = Number(targetBook?.epubLocation?.updatedAt || 0);
  if (sourceBook.epubLocation && sourceEpubUpdated >= targetEpubUpdated) {
    targetBook.epubLocation = sourceBook.epubLocation;
  }

  if (!targetBook.fileFingerprint && sourceBook.fileFingerprint) {
    targetBook.fileFingerprint = sourceBook.fileFingerprint;
  }

  const sourceCreatedAt = Number(sourceBook.createdAt || 0);
  const targetCreatedAt = Number(targetBook.createdAt || 0);
  if (sourceCreatedAt > 0 && (targetCreatedAt <= 0 || sourceCreatedAt < targetCreatedAt)) {
    targetBook.createdAt = sourceCreatedAt;
  }

  if (!targetBook.pinnedAt && sourceBook.pinnedAt) {
    targetBook.pinnedAt = sourceBook.pinnedAt;
  }

  const sourceFirstReadAt = Number(sourceBook.firstReadAt || 0);
  const targetFirstReadAt = Number(targetBook.firstReadAt || 0);
  if (sourceFirstReadAt > 0 && (targetFirstReadAt <= 0 || sourceFirstReadAt < targetFirstReadAt)) {
    targetBook.firstReadAt = sourceFirstReadAt;
  }

  const sourceLastReadStartAt = Number(sourceBook.lastReadStartAt || 0);
  const targetLastReadStartAt = Number(targetBook.lastReadStartAt || 0);
  if (sourceLastReadStartAt > targetLastReadStartAt) {
    targetBook.lastReadStartAt = sourceLastReadStartAt;
  }

  const sourceSessions = Math.max(0, Number(sourceBook.readSessionCount || 0));
  const targetSessions = Math.max(0, Number(targetBook.readSessionCount || 0));
  if (sourceSessions > 0 || targetSessions > 0) {
    targetBook.readSessionCount = targetSessions + sourceSessions;
  }

  delete targetBook.missingOnDisk;
  delete targetBook.missingAt;
}

function toIsoTimestamp(value) {
  const n = Number(value || 0);
  if (n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch (e) {
    return null;
  }
}

function markBookReadingStart(bookId, startedAt = Date.now()) {
  const id = String(bookId || '');
  if (!id) return null;

  const book = appData.books?.[id];
  if (!book) return null;

  const now = Date.now();
  const tsRaw = Number(startedAt);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now;

  if (!book.firstReadAt || Number(book.firstReadAt) <= 0) {
    book.firstReadAt = ts;
  }
  book.lastReadStartAt = ts;
  book.readSessionCount = Math.max(0, Number(book.readSessionCount || 0)) + 1;

  saveData();
  return {
    bookId: id,
    firstReadAt: Number(book.firstReadAt || 0),
    lastReadStartAt: Number(book.lastReadStartAt || 0),
    readSessionCount: Number(book.readSessionCount || 0)
  };
}

function getBookMetainfo(bookId) {
  const id = String(bookId || '');
  if (!id) return null;

  const book = appData.books?.[id];
  if (!book) return null;

  ensureLibraryBookMap();

  const physicalLibrary = appData.libraries.find(lib => String(lib?.id || '') === String(book.libraryId || ''));
  const logicalLibraries = [];
  for (const lib of appData.libraries || []) {
    if (!isLogicalLibrary(lib) || !lib?.id) continue;
    const ids = Array.isArray(appData.libraryBookMap?.[lib.id]) ? appData.libraryBookMap[lib.id] : [];
    if (ids.some(candidateId => String(candidateId || '') === id)) {
      logicalLibraries.push({ id: lib.id, name: lib.name || 'Library' });
    }
  }

  const fileMeta = {
    exists: false,
    sizeBytes: null,
    modifiedAt: null,
    modifiedAtISO: null
  };
  if (book.path && isExistingFile(book.path)) {
    try {
      const stats = fs.statSync(book.path);
      if (stats.isFile()) {
        fileMeta.exists = true;
        fileMeta.sizeBytes = Number(stats.size || 0);
        fileMeta.modifiedAt = Number(stats.mtimeMs || 0);
        fileMeta.modifiedAtISO = toIsoTimestamp(stats.mtimeMs);
      }
    } catch (e) {}
  }

  const bookmarkCount = Array.isArray(appData.bookmarks?.[id]) ? appData.bookmarks[id].length : 0;
  const highlightCount = Array.isArray(appData.highlights?.[id]) ? appData.highlights[id].length : 0;
  const noteCount = Array.isArray(appData.notes?.[id]) ? appData.notes[id].length : 0;

  const generatedAt = Date.now();
  return {
    schemaVersion: 1,
    generatedAt,
    generatedAtISO: toIsoTimestamp(generatedAt),
    book: { ...book },
    computed: {
      physicalLibrary: physicalLibrary
        ? { id: physicalLibrary.id, name: physicalLibrary.name || 'Library', type: physicalLibrary.type || 'physical' }
        : null,
      logicalLibraries,
      libraryCount: logicalLibraries.length + (physicalLibrary ? 1 : 0),
      bookmarkCount,
      highlightCount,
      noteCount,
      annotationCount: bookmarkCount + highlightCount + noteCount,
      file: fileMeta,
      firstReadAtISO: toIsoTimestamp(book.firstReadAt),
      lastReadStartAtISO: toIsoTimestamp(book.lastReadStartAt),
      lastReadISO: toIsoTimestamp(book.lastRead),
      firstCompletedAtISO: toIsoTimestamp(book.firstCompletedAt),
      completedAtISO: toIsoTimestamp(book.completedAt),
      createdAtISO: toIsoTimestamp(book.createdAt),
      readSessionCount: Number(book.readSessionCount || 0)
    }
  };
}

function replaceBookIdInNode(root, sourceBookId, targetBookId) {
  if (!root) return false;
  const sourceId = String(sourceBookId || '');
  const targetId = String(targetBookId || '');
  if (!sourceId || !targetId || sourceId === targetId) return false;

  let changed = false;
  const nextBooks = [];
  const seen = new Set();

  for (const rawId of root.books || []) {
    let id = String(rawId || '');
    if (!id) {
      changed = true;
      continue;
    }
    if (id === sourceId) {
      id = targetId;
      changed = true;
    }
    if (seen.has(id)) {
      changed = true;
      continue;
    }
    seen.add(id);
    nextBooks.push(id);
  }

  root.books = nextBooks;
  for (const child of root.children || []) {
    if (replaceBookIdInNode(child, sourceId, targetId)) changed = true;
  }

  return changed;
}

function mergeDuplicateBooksForIds(bookIds) {
  const ids = [...new Set((bookIds || []).map(id => String(id || '')).filter(Boolean))];
  if (ids.length < 2) return 0;

  const entries = ids
    .map(id => ({ id, book: appData.books?.[id] }))
    .filter(entry => !!entry.book);
  if (entries.length < 2) return 0;

  const primaryEntry = pickMostRecentBookEntry(entries) || entries[0];
  if (!primaryEntry?.book) return 0;

  const primaryId = String(primaryEntry.id);
  const primaryBook = primaryEntry.book;
  let mergedCount = 0;

  for (const entry of entries) {
    const duplicateId = String(entry.id || '');
    if (!duplicateId || duplicateId === primaryId) continue;

    const duplicateBook = appData.books?.[duplicateId];
    if (!duplicateBook) continue;

    mergeBookState(primaryBook, duplicateBook);
    mergeBookCollection(primaryId, duplicateId, 'bookmarks');
    mergeBookCollection(primaryId, duplicateId, 'highlights');
    mergeBookCollection(primaryId, duplicateId, 'notes');

    const primaryPathMissing = !primaryBook.path || !isExistingFile(primaryBook.path);
    const duplicatePathExists = !!duplicateBook.path && isExistingFile(duplicateBook.path);
    if (primaryPathMissing && duplicatePathExists) {
      primaryBook.path = duplicateBook.path;
      delete primaryBook.missingOnDisk;
      delete primaryBook.missingAt;
    }

    if (!primaryBook.libraryId && duplicateBook.libraryId) primaryBook.libraryId = duplicateBook.libraryId;
    if (!primaryBook.coverFile && duplicateBook.coverFile) primaryBook.coverFile = duplicateBook.coverFile;
    if (!primaryBook.coverMime && duplicateBook.coverMime) primaryBook.coverMime = duplicateBook.coverMime;
    if (!primaryBook.fileFingerprint && duplicateBook.fileFingerprint) primaryBook.fileFingerprint = duplicateBook.fileFingerprint;

    for (const library of appData.libraries || []) {
      replaceBookIdInNode(library.structure, duplicateId, primaryId);
    }
    replaceBookIdInLogicalLibraries(duplicateId, primaryId);

    delete appData.books[duplicateId];
    delete appData.bookmarks[duplicateId];
    delete appData.highlights[duplicateId];
    delete appData.notes[duplicateId];
    mergedCount += 1;
  }

  return mergedCount;
}

function hasSharedBaseName(entries) {
  const seen = new Set();
  for (const entry of entries || []) {
    const base = normalizeBaseName(entry?.book?.path);
    if (!base) continue;
    if (seen.has(base)) return true;
    seen.add(base);
  }
  return false;
}

function canMergeLooseMetadataGroup(entries) {
  if (!Array.isArray(entries) || entries.length < 2) return false;
  if (hasSharedBaseName(entries)) return true;

  const meaningfulCount = entries.filter(entry => hasMeaningfulReadingState(entry.id, entry.book)).length;
  if (meaningfulCount > 0 && meaningfulCount < entries.length) return true;

  const hasMissing = entries.some(entry => !!entry?.book?.missingOnDisk);
  const hasActive = entries.some(entry => !entry?.book?.missingOnDisk);
  if (hasMissing && hasActive) return true;

  return false;
}

function mergeDuplicateBooksByKey(keyFn, guardFn = null) {
  if (typeof keyFn !== 'function') return 0;
  const idsByKey = new Map();

  for (const [bookId, book] of Object.entries(appData.books || {})) {
    const key = keyFn(book);
    if (!key) continue;
    if (!idsByKey.has(key)) idsByKey.set(key, []);
    idsByKey.get(key).push(bookId);
  }

  let mergedCount = 0;
  for (const ids of idsByKey.values()) {
    if (ids.length < 2) continue;
    if (typeof guardFn === 'function') {
      const entries = ids
        .map(id => ({ id, book: appData.books?.[id] }))
        .filter(entry => !!entry.book);
      if (entries.length < 2) continue;
      if (!guardFn(entries)) continue;
    }
    mergedCount += mergeDuplicateBooksForIds(ids);
  }

  return mergedCount;
}

function mergeDuplicateBooks() {
  for (const book of Object.values(appData.books || {})) {
    if (!book) continue;
    if (!book.fileFingerprint && book.path && isExistingFile(book.path)) {
      const fingerprint = computeFileFingerprint(book.path);
      if (fingerprint) book.fileFingerprint = fingerprint;
    }
  }

  let mergedCount = 0;
  mergedCount += mergeDuplicateBooksByKey(getBookDuplicateMergeKey);
  mergedCount += mergeDuplicateBooksByKey(getBookExactMetaMergeKey);
  mergedCount += mergeDuplicateBooksByKey(getBookLooseMetaMergeKey, canMergeLooseMetadataGroup);

  if (mergedCount > 0) {
    ensureLibraryBookMap();
    console.log(`Merged duplicate book records: ${mergedCount}`);
  }

  return mergedCount;
}

function getMovedBookMatchScore(sourceBook, targetBook) {
  const fingerprintMatch = sourceBook.fileFingerprint
    && targetBook.fileFingerprint
    && sourceBook.fileFingerprint === targetBook.fileFingerprint;
  const sourceBase = normalizeBaseName(sourceBook.path);
  const targetBase = normalizeBaseName(targetBook.path);
  const sameBaseName = sourceBase && sourceBase === targetBase;
  const sourceMissingAt = Number(sourceBook.missingAt || 0);
  const targetCreatedAt = Number(targetBook.createdAt || 0);
  const createdNearMissing = sourceMissingAt > 0
    && targetCreatedAt > 0
    && targetCreatedAt >= (sourceMissingAt - 5 * 60 * 1000)
    && targetCreatedAt <= (sourceMissingAt + 45 * 24 * 60 * 60 * 1000);

  if (!fingerprintMatch && !sameBaseName && !createdNearMissing) return 0;
  return (fingerprintMatch ? 100 : 0) + (sameBaseName ? 10 : 0) + (createdNearMissing ? 1 : 0);
}

function recoverMovedBookProgress() {
  const booksById = appData.books || {};
  const groups = new Map();

  for (const [bookId, book] of Object.entries(booksById)) {
    if (!book?.format) continue;
    const fileMissing = book.path ? !isExistingFile(book.path) : false;
    if (fileMissing && !book.missingOnDisk) markBookMissing(bookId);

    const titleKey = normalizeIdentityText(book.title);
    const authorKey = normalizeIdentityText(book.author || 'unknown');
    if (!titleKey || !authorKey) continue;
    const groupKey = `meta|${book.format}|${titleKey}|${authorKey}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { active: [], missing: [] });
    const bucket = groups.get(groupKey);
    if (book.missingOnDisk || fileMissing) bucket.missing.push(bookId);
    else bucket.active.push(bookId);
  }

  let mergedCount = 0;

  for (const bucket of groups.values()) {
    if (bucket.active.length === 0 || bucket.missing.length === 0) continue;

    for (const sourceBookId of bucket.missing) {
      const sourceBook = booksById[sourceBookId];
      if (!sourceBook) continue;
      if (!hasMeaningfulReadingState(sourceBookId, sourceBook)) continue;

      let bestTargetBookId = null;
      let bestScore = 0;
      for (const targetBookId of bucket.active) {
        const targetBook = booksById[targetBookId];
        if (!targetBook) continue;
        if (hasMeaningfulReadingState(targetBookId, targetBook)) continue;
        const score = getMovedBookMatchScore(sourceBook, targetBook);
        if (score > bestScore) {
          bestScore = score;
          bestTargetBookId = targetBookId;
        }
      }

      if (!bestTargetBookId) continue;

      const targetBook = booksById[bestTargetBookId];
      if (!targetBook) continue;

      mergeBookState(targetBook, sourceBook);
      mergeBookCollection(bestTargetBookId, sourceBookId, 'bookmarks');
      mergeBookCollection(bestTargetBookId, sourceBookId, 'highlights');
      mergeBookCollection(bestTargetBookId, sourceBookId, 'notes');

      for (const lib of appData.libraries || []) {
        removeBookFromNode(lib.structure, sourceBookId);
      }
      replaceBookIdInLogicalLibraries(sourceBookId, bestTargetBookId);

      delete booksById[sourceBookId];
      delete appData.bookmarks[sourceBookId];
      delete appData.highlights[sourceBookId];
      delete appData.notes[sourceBookId];
      mergedCount += 1;
    }
  }

  if (mergedCount > 0) {
    console.log(`Recovered moved-book reading state for ${mergedCount} book(s)`);
  }
  return mergedCount;
}

function migrateLegacyBookIds() {
  const oldBooks = appData.books || {};
  const entries = Object.entries(oldBooks);
  if (entries.length === 0) return;

  const looksLegacy = entries.some(([id, book]) => {
    if (!book?.path) return false;
    return id === hashPath(book.path);
  });
  if (!looksLegacy) return;

  const idMap = new Map(); // oldId -> newId
  const newBooks = {};

  for (const [oldId, book] of entries) {
    if (!book) continue;
    const isLegacy = book.path && oldId === hashPath(book.path);
    const newId = isLegacy ? generateId() : (book.id || oldId);
    const migrated = { ...book, id: newId };
    newBooks[newId] = migrated;
    if (newId !== oldId) idMap.set(oldId, newId);
  }

  const remapBookIdsInNode = (node) => {
    if (!node) return;
    node.books = (node.books || []).map(id => idMap.get(id) || id);
    (node.children || []).forEach(remapBookIdsInNode);
  };
  (appData.libraries || []).forEach(lib => remapBookIdsInNode(lib.structure));

  const remapKeyedCollection = (collection) => {
    const out = {};
    for (const [key, val] of Object.entries(collection || {})) {
      out[idMap.get(key) || key] = val;
    }
    return out;
  };

  const remapLibraryBookMap = (map) => {
    const out = {};
    for (const [libraryId, ids] of Object.entries(map || {})) {
      out[libraryId] = (Array.isArray(ids) ? ids : []).map(id => idMap.get(id) || id);
    }
    return out;
  };

  appData.books = newBooks;
  appData.bookmarks = remapKeyedCollection(appData.bookmarks);
  appData.highlights = remapKeyedCollection(appData.highlights);
  appData.notes = remapKeyedCollection(appData.notes);
  appData.libraryBookMap = remapLibraryBookMap(appData.libraryBookMap);
}

function ensureLibraryNodeIds() {
  for (const lib of appData.libraries || []) {
    if (!lib.structure) continue;
    const rootPath = lib.path || null;

    const walk = (node, parentRel = '') => {
      if (!node) return;
      const relPath = node.relPath ?? (node.path && rootPath
        ? path.relative(rootPath, node.path).split(path.sep).join('/')
        : parentRel);
      node.relPath = relPath || '';
      if (!node.id) node.id = hashPath(`node:${lib.id}:${node.relPath}`);
      node.children = node.children || [];
      node.books = node.books || [];
      node.children.forEach(child => walk(child, node.relPath ? `${node.relPath}/${child.name}` : child.name));
    };
    walk(lib.structure, '');
  }
}

function ensureBookDefaults() {
  let changed = false;
  for (const book of Object.values(appData.books || {})) {
    if (!book) continue;

    const detectedFormat = detectFormat(String(book.path || ''));
    const currentFormat = String(book.format || '').toLowerCase();
    if (detectedFormat && currentFormat !== detectedFormat) {
      book.format = detectedFormat;
      changed = true;
    }

    if (!book.createdAt) {
      book.createdAt = Date.now();
      changed = true;
    }

    const lastRead = Number(book.lastRead || 0);
    const firstReadAt = Number(book.firstReadAt || 0);
    if (firstReadAt <= 0 && lastRead > 0) {
      book.firstReadAt = lastRead;
      changed = true;
    }

    const normalizedFirstReadAt = Number(book.firstReadAt || 0);
    const lastReadStartAt = Number(book.lastReadStartAt || 0);
    if (lastReadStartAt <= 0) {
      const backfilledStart = lastRead > 0 ? lastRead : normalizedFirstReadAt;
      if (backfilledStart > 0) {
        book.lastReadStartAt = backfilledStart;
        changed = true;
      }
    }

    const sessionCount = Number(book.readSessionCount || 0);
    if (!(sessionCount > 0)) {
      const hasReadingSignal = lastRead > 0
        || Number(book.progress || 0) > 0.01
        || Number(book.timeSpent || 0) > 0
        || Number(book.firstCompletedAt || 0) > 0
        || Number(book.completedAt || 0) > 0
        || Number(book?.epubLocation?.updatedAt || 0) > 0;
      if (hasReadingSignal) {
        book.readSessionCount = 1;
        changed = true;
      }
    }
  }
  return changed;
}

function detectFormat(filePath) {
  const fullPath = String(filePath || '');
  const ext = path.extname(fullPath).toLowerCase().trim();
  if (ext === '.epub') return 'epub';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'txt';
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd' || ext === '.mkdn' || ext === '.mdx') return 'md';

  const normalizedName = path.basename(fullPath).toLowerCase().trim();
  if (/\.(md|markdown|mdown|mkd|mkdn|mdx)$/.test(normalizedName)) return 'md';
  return null;
}

async function getEpubMetadata(filePath) {
  return new Promise((resolve) => {
    const epub = new EPub(filePath);
    epub.on('end', () => {
      resolve({
        title: epub.metadata.title || path.basename(filePath, '.epub'),
        author: epub.metadata.creator || 'Unknown'
      });
    });
    epub.on('error', () => {
      resolve({ title: path.basename(filePath, '.epub'), author: 'Unknown' });
    });
    epub.parse();
  });
}

function scanDir(dir, libraryId) {
  throw new Error('scanDir legacy signature should not be used');
}

function listBookFiles(dirPath) {
  const walkDir = (dir) => {
    let files = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(walkDir(fullPath));
        } else if (detectFormat(fullPath)) {
          files.push(fullPath);
        }
      }
    } catch (e) {}
    return files;
  };
  return walkDir(dirPath);
}

function computeFileFingerprint(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;

    const fileSize = Number(stats.size || 0);
    const hasher = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');

    try {
      const headBytes = Math.min(FILE_FINGERPRINT_SAMPLE_BYTES, fileSize);
      if (headBytes > 0) {
        const head = Buffer.allocUnsafe(headBytes);
        const readHead = fs.readSync(fd, head, 0, headBytes, 0);
        if (readHead > 0) hasher.update(head.subarray(0, readHead));
      }

      if (fileSize > FILE_FINGERPRINT_SAMPLE_BYTES) {
        const tailBytes = Math.min(FILE_FINGERPRINT_SAMPLE_BYTES, fileSize);
        const tail = Buffer.allocUnsafe(tailBytes);
        const tailPos = Math.max(0, fileSize - tailBytes);
        const readTail = fs.readSync(fd, tail, 0, tailBytes, tailPos);
        if (readTail > 0) hasher.update(tail.subarray(0, readTail));
      }
    } finally {
      fs.closeSync(fd);
    }

    const digest = hasher.digest('hex').slice(0, 24);
    return digest;
  } catch (e) {
    return null;
  }
}

async function ensureBooksForFiles(files, libraryId) {
  const existingByPath = new Map();
  const missingByFingerprint = new Map();

  for (const [bookId, book] of Object.entries(appData.books || {})) {
    if (book?.path) existingByPath.set(book.path, bookId);
    const fileMissing = book?.path ? !isExistingFile(book.path) : false;
    if (fileMissing && !book?.missingOnDisk) markBookMissing(bookId);
    const treatAsMissing = !!book?.missingOnDisk || fileMissing;
    if (!treatAsMissing || !book?.fileFingerprint) continue;
    if (!missingByFingerprint.has(book.fileFingerprint)) missingByFingerprint.set(book.fileFingerprint, []);
    missingByFingerprint.get(book.fileFingerprint).push(bookId);
  }

  const takeMissingByFingerprint = (fingerprint) => {
    const ids = missingByFingerprint.get(fingerprint);
    if (!ids || ids.length === 0) return null;
    const sameLibraryIndex = ids.findIndex((candidateId) => {
      const candidate = appData.books[candidateId];
      return candidate?.missingOnDisk && candidate?.libraryId === libraryId;
    });
    if (sameLibraryIndex >= 0) {
      const [candidateId] = ids.splice(sameLibraryIndex, 1);
      return candidateId;
    }
    while (ids.length > 0) {
      const candidateId = ids.shift();
      if (appData.books[candidateId]?.missingOnDisk) return candidateId;
    }
    return null;
  };

  const pathToBookId = {};
  for (const filePath of files) {
    const format = detectFormat(filePath);
    let id = existingByPath.get(filePath);
    let fingerprint = null;

    if (!id || !appData.books[id]) {
      fingerprint = computeFileFingerprint(filePath);
      if (fingerprint) {
        const movedBookId = takeMissingByFingerprint(fingerprint);
        if (movedBookId) id = movedBookId;
      }
    }

    if (!id || !appData.books[id]) {
      id = generateId();
      let title = path.basename(filePath, path.extname(filePath));
      let author = 'Unknown';

      if (format === 'epub') {
        const meta = await getEpubMetadata(filePath);
        title = meta.title;
        author = meta.author;
      } else if (format === 'md') {
        const meta = await getMarkdownMetadata(filePath);
        title = meta.title;
        author = meta.author;
      }

      appData.books[id] = {
        id,
        title,
        author,
        path: filePath,
        format,
        progress: 0,
        libraryId,
        createdAt: Date.now(),
        fileFingerprint: fingerprint || null
      };
      existingByPath.set(filePath, id);
    }

    const book = appData.books[id];
    const previousLibraryId = book.libraryId;
    const pathChanged = book.path !== filePath;
    book.path = filePath;
    book.libraryId = libraryId;
    if (previousLibraryId && previousLibraryId !== libraryId) {
      const previousLibrary = appData.libraries.find(l => l.id === previousLibraryId);
      if (previousLibrary?.structure) {
        removeBookFromNode(previousLibrary.structure, id);
      }
    }
    if (!book.createdAt) book.createdAt = Date.now();
    if (format) book.format = format;

    if (!fingerprint && (pathChanged || !book.fileFingerprint || book.missingOnDisk)) {
      fingerprint = computeFileFingerprint(filePath);
    }
    if (fingerprint) book.fileFingerprint = fingerprint;

    if (book.missingOnDisk) {
      delete book.missingOnDisk;
      delete book.missingAt;
    }

    existingByPath.set(filePath, id);
    pathToBookId[filePath] = id;
  }

  return pathToBookId;
}

function buildDirStructure(dirPath, libraryId, libraryName, pathToBookId) {
  const rootPath = dirPath;
  const toRel = (absPath) => {
    const rel = path.relative(rootPath, absPath);
    return rel ? rel.split(path.sep).join('/') : '';
  };

  const scan = (dir, isRoot = false) => {
    const relPath = toRel(dir);
    const node = {
      id: hashPath(`node:${libraryId}:${relPath}`),
      name: isRoot ? libraryName : path.basename(dir),
      path: dir,
      relPath,
      children: [],
      books: []
    };

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          node.children.push(scan(fullPath));
        } else if (detectFormat(fullPath)) {
          const bookId = pathToBookId[fullPath];
          if (bookId) node.books.push(bookId);
        }
      }
    } catch (e) {}

    node.children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    node.books.sort((aId, bId) => {
      const a = appData.books[aId];
      const b = appData.books[bId];
      return (a?.title || '').localeCompare(b?.title || '');
    });
    return node;
  };

  return scan(dirPath, true);
}

async function createLibrary(name, dirPath = null) {
  const id = generateId();
  const physical = !!dirPath;
  if (physical) markBooksMissingForUnavailableLibraries(true);

  let structure;
  if (physical) {
    const files = listBookFiles(dirPath);
    const pathToBookId = await ensureBooksForFiles(files, id);
    structure = buildDirStructure(dirPath, id, name || path.basename(dirPath), pathToBookId);
  } else {
    structure = {
      id: hashPath(`node:${id}:`),
      name: name || 'Library',
      path: null,
      relPath: '',
      children: [],
      books: []
    };
  }

  const library = {
    id,
    name: name || 'Library',
    type: physical ? 'physical' : 'logical',
    path: physical ? dirPath : null,
    structure,
    createdAt: Date.now()
  };

  appData.libraries.push(library);
  ensureLibraryBookMap();
  if (isLogicalLibrary(library) && !Array.isArray(appData.libraryBookMap[library.id])) {
    appData.libraryBookMap[library.id] = [];
  }
  recoverMovedBookProgress();
  synchronizeDuplicateBookProgress();
  saveData();
  if (isPhysicalLibrary(library)) startLibraryWatcher(library);
  return library;
}

async function createEmptyLibrary(name) {
  return createLibrary(name, null);
}

function addBookToLogicalLibrary(libraryId, bookId) {
  const library = appData.libraries.find(l => l.id === libraryId);
  if (!library) throw new Error('Library not found');
  if (!isLogicalLibrary(library)) throw new Error('Can only add books to logical libraries');
  const book = appData.books[bookId];
  if (!book) throw new Error('Book not found');

  ensureLibraryBookMap();
  const list = Array.isArray(appData.libraryBookMap[libraryId]) ? appData.libraryBookMap[libraryId] : [];
  const id = String(bookId);
  if (!list.includes(id)) list.push(id);
  appData.libraryBookMap[libraryId] = list;
  saveData();
  return { success: true, libraryId, count: list.length };
}

function removeBookFromLogicalLibrary(libraryId, bookId) {
  const library = appData.libraries.find(l => l.id === libraryId);
  if (!library) throw new Error('Library not found');
  if (!isLogicalLibrary(library)) throw new Error('Can only remove books from logical libraries');

  ensureLibraryBookMap();
  const list = Array.isArray(appData.libraryBookMap[libraryId]) ? appData.libraryBookMap[libraryId] : [];
  appData.libraryBookMap[libraryId] = list.filter(id => String(id) !== String(bookId));
  if (appData.books?.[bookId] && String(appData.books[bookId].libraryId || '') === String(libraryId)) {
    delete appData.books[bookId].libraryId;
  }
  saveData();
  return { success: true, libraryId, count: appData.libraryBookMap[libraryId].length };
}

function deleteLibrary(libraryId, deleteMode = 'keep') {
  if (deleteMode === true) deleteMode = 'books';
  if (deleteMode === false) deleteMode = 'keep';

  const library = appData.libraries.find(l => l.id === libraryId);
  if (!library) return;
  stopLibraryWatcher(libraryId);

  if (isLogicalLibrary(library)) {
    ensureLibraryBookMap();
    delete appData.libraryBookMap[libraryId];
    appData.libraries = appData.libraries.filter(l => l.id !== libraryId);
    saveData();
    return;
  }

  const bookIds = collectBookIdsFromNode(library.structure);
  for (const b of Object.values(appData.books || {})) {
    if (b?.libraryId === libraryId) bookIds.add(String(b.id));
  }

  bookIds.forEach((bookId) => {
    const book = appData.books[bookId];
    if (book) {
      if (deleteMode === 'books' && fs.existsSync(book.path)) {
        try { fs.unlinkSync(book.path); } catch (e) {}
      }
      replaceBookIdInLogicalLibraries(bookId, null);
      delete appData.books[bookId];
    }
    delete appData.bookmarks[bookId];
    delete appData.highlights[bookId];
    delete appData.notes[bookId];
  });

  if (deleteMode === 'dir' && library.path) {
    try { fs.rmSync(library.path, { recursive: true, force: true }); } catch (e) {}
  }

  appData.libraries = appData.libraries.filter(l => l.id !== libraryId);
  if (appData.libraryBookMap?.[libraryId]) delete appData.libraryBookMap[libraryId];
  saveData();
}

function deleteBook(bookId, deleteFile = false) {
  const book = appData.books[bookId];
  if (!book) return;

  if (deleteFile && fs.existsSync(book.path)) {
    try { fs.unlinkSync(book.path); } catch (e) {}
  }

  appData.libraries.forEach(lib => {
    const removeFromNode = (node) => {
      if (!node) return;
      node.books = node.books.filter(id => id !== bookId);
      node.children.forEach(removeFromNode);
    };
    removeFromNode(lib.structure);
  });

  delete appData.books[bookId];
  delete appData.bookmarks[bookId];
  delete appData.highlights[bookId];
  delete appData.notes[bookId];
  replaceBookIdInLogicalLibraries(bookId, null);
  saveData();
}

function markBookMissing(bookId) {
  const book = appData.books[bookId];
  if (!book) return;
  if (book.missingOnDisk) return;
  book.missingOnDisk = true;
  book.missingAt = Date.now();
}

function markBooksMissingForUnavailableLibraries(removeFromStructure = false, onlyLibraryId = null) {
  let changed = 0;

  for (const library of appData.libraries || []) {
    if (!library?.id || !isPhysicalLibrary(library) || !library.path) continue;
    if (onlyLibraryId && library.id !== onlyLibraryId) continue;
    if (isExistingDirectory(library.path)) continue;

    for (const [bookId, book] of Object.entries(appData.books || {})) {
      if (!book || book.libraryId !== library.id) continue;
      if (removeFromStructure && library.structure) removeBookFromNode(library.structure, bookId);
      const wasMissing = !!book.missingOnDisk;
      markBookMissing(bookId);
      if (!wasMissing && appData.books[bookId]?.missingOnDisk) changed += 1;
    }
  }

  return changed;
}

async function rescanLibrary(libraryId, patchOnly = false) {
  const library = appData.libraries.find(l => l.id === libraryId);
  if (!library || !isPhysicalLibrary(library) || !library.path) return;

  const files = listBookFiles(library.path);
  const fileSet = new Set(files);
  const markMissingBooksForLibrary = (removeFromStructure) => {
    for (const [id, b] of Object.entries(appData.books || {})) {
      if (b?.libraryId === libraryId && b?.path && !fileSet.has(b.path)) {
        if (removeFromStructure && library.structure) removeBookFromNode(library.structure, id);
        markBookMissing(id);
      }
    }
  };

  if (patchOnly) {
    if (!library.structure) {
      library.structure = {
        id: hashPath(`node:${libraryId}:`),
        name: library.name || path.basename(library.path),
        path: library.path,
        relPath: '',
        children: [],
        books: []
      };
    }

    const ensureFolderNode = (relPath) => {
      if (!library.structure) return null;
      const parts = (relPath || '').split('/').filter(Boolean);
      let node = library.structure;
      for (let i = 0; i < parts.length; i++) {
        const segment = parts[i];
        const subRel = parts.slice(0, i + 1).join('/');
        node.children = node.children || [];
        let child = node.children.find(c => (c.relPath || c.name) === subRel || c.name === segment);
        if (!child) {
          child = {
            id: hashPath(`node:${libraryId}:${subRel}`),
            name: segment,
            path: library.path ? path.join(library.path, ...parts.slice(0, i + 1)) : null,
            relPath: subRel,
            children: [],
            books: []
          };
          node.children.push(child);
          node.children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        node = child;
      }
      return node;
    };

    markMissingBooksForLibrary(true);
    const pathToBookId = await ensureBooksForFiles(files, libraryId);

    for (const filePath of files) {
      if (!library.structure) continue;
      const id = pathToBookId[filePath];
      if (!id) continue;

      const relDir = path.relative(library.path, path.dirname(filePath)).split(path.sep).join('/');
      const targetNode = ensureFolderNode(relDir);
      if (!targetNode) continue;

      removeBookFromNode(library.structure, id);
      targetNode.books = targetNode.books || [];
      targetNode.books.push(id);
      targetNode.books.sort((aId, bId) => {
        const firstBook = appData.books[aId];
        const secondBook = appData.books[bId];
        return (firstBook?.title || '').localeCompare(secondBook?.title || '');
      });
    }

  } else {
    // Mark missing first so moved files can reclaim existing book IDs by fingerprint.
    markMissingBooksForLibrary(false);
    // Full rescan: rebuild entire structure
    const pathToBookId = await ensureBooksForFiles(files, libraryId);
    library.structure = buildDirStructure(library.path, libraryId, library.name, pathToBookId);
  }
  recoverMovedBookProgress();
  synchronizeDuplicateBookProgress();
  saveData();
}

async function refreshStandaloneBooksFromKnownDirectories() {
  const physicalLibraries = (appData.libraries || []).filter(lib => isPhysicalLibrary(lib) && !!lib?.path);
  if (physicalLibraries.length > 0) return 0;

  const books = Object.values(appData.books || {}).filter(book => {
    const filePath = String(book?.path || '').trim();
    return !!filePath && isExistingFile(filePath);
  });
  if (!books.length) return 0;

  const rawDirs = [...new Set(books.map(book => path.resolve(path.dirname(String(book.path || '')))))];
  rawDirs.sort((left, right) => left.length - right.length);

  const roots = [];
  for (const dir of rawDirs) {
    if (!isExistingDirectory(dir)) continue;
    const covered = roots.some(root => dir === root || dir.startsWith(`${root}${path.sep}`));
    if (!covered) roots.push(dir);
  }
  if (!roots.length) return 0;

  const fileSet = new Set();
  for (const root of roots) {
    const files = listBookFiles(root);
    files.forEach(filePath => fileSet.add(filePath));
  }

  const files = [...fileSet];
  if (!files.length) return 0;

  const beforeCount = Object.keys(appData.books || {}).length;
  await ensureBooksForFiles(files, null);
  const afterCount = Object.keys(appData.books || {}).length;

  recoverMovedBookProgress();
  synchronizeDuplicateBookProgress();
  return Math.max(0, afterCount - beforeCount);
}

async function autoRefreshLibrariesOnLaunch() {
  const libraries = appData.libraries || [];
  let hadChanges = markBooksMissingForUnavailableLibraries(true) > 0;

  for (const lib of libraries) {
    if (!lib?.path || !isPhysicalLibrary(lib)) continue;
    try {
      const stats = fs.statSync(lib.path);
      if (!stats.isDirectory()) continue;
    } catch (e) {
      continue;
    }

    try {
      await rescanLibrary(lib.id, true);
      hadChanges = true;
    } catch (e) {
      console.warn('Auto refresh failed for library', lib.name || lib.id, e?.message || e);
    }
  }

  try {
    const addedFromStandalone = await refreshStandaloneBooksFromKnownDirectories();
    if (addedFromStandalone > 0) {
      hadChanges = true;
      console.log(`Discovered ${addedFromStandalone} book(s) from standalone all-books directories`);
    }
  } catch (e) {
    console.warn('Standalone all-books refresh failed', e?.message || e);
  }

  if (hadChanges) saveData();
  notifyLibrariesAutoRefreshed({ source: 'launch', silent: false });
}

function isExistingDirectory(dirPath) {
  if (!dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (e) {
    return false;
  }
}

function listDirectoriesRecursive(rootDir) {
  if (!isExistingDirectory(rootDir)) return [];
  const result = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const dir = queue.shift();
    result.push(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      queue.push(path.join(dir, entry.name));
    }
  }

  return result;
}

function closeWatcherState(state) {
  if (!state) return;
  if (state.rescanTimer) {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = null;
  }
  if (state.syncTimer) {
    clearTimeout(state.syncTimer);
    state.syncTimer = null;
  }
  for (const watcher of state.watchers.values()) {
    try { watcher.close(); } catch (e) {}
  }
  state.watchers.clear();
}

function stopLibraryWatcher(libraryId) {
  const state = libraryWatchers.get(libraryId);
  if (!state) return;
  closeWatcherState(state);
  libraryWatchers.delete(libraryId);
}

function attachDirectoryWatcher(libraryId, dirPath) {
  const state = libraryWatchers.get(libraryId);
  if (!state || state.watchers.has(dirPath)) return;

  let watcher;
  try {
    watcher = fs.watch(dirPath, { persistent: true }, (eventType) => {
      scheduleLibraryWatcherSync(libraryId);
      scheduleLibraryRescan(libraryId, eventType || 'change');
    });
  } catch (e) {
    console.warn('Failed to watch directory', dirPath, e?.message || e);
    return;
  }

  watcher.on('error', (e) => {
    console.warn('Directory watcher error', dirPath, e?.message || e);
    scheduleLibraryWatcherSync(libraryId);
    scheduleLibraryRescan(libraryId, 'watch-error');
  });

  state.watchers.set(dirPath, watcher);
}

function syncLibraryWatcherDirectories(libraryId) {
  const state = libraryWatchers.get(libraryId);
  if (!state) return;

  const library = appData.libraries.find(l => l.id === libraryId);
  if (!isPhysicalLibrary(library) || !library?.path || !isExistingDirectory(library.path)) {
    if (markBooksMissingForUnavailableLibraries(true, libraryId) > 0) saveData();
    stopLibraryWatcher(libraryId);
    return;
  }

  const directories = new Set(listDirectoriesRecursive(library.path));

  for (const dir of directories) {
    attachDirectoryWatcher(libraryId, dir);
  }

  for (const [watchedDir, watcher] of state.watchers.entries()) {
    if (directories.has(watchedDir)) continue;
    try { watcher.close(); } catch (e) {}
    state.watchers.delete(watchedDir);
  }
}

function scheduleLibraryWatcherSync(libraryId) {
  const state = libraryWatchers.get(libraryId);
  if (!state) return;
  if (state.syncTimer) clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => {
    state.syncTimer = null;
    syncLibraryWatcherDirectories(libraryId);
  }, LIBRARY_WATCH_RESYNC_MS);
}

async function runLibraryWatchRescan(libraryId, reason = 'filesystem') {
  const state = libraryWatchers.get(libraryId);
  if (!state) return;

  if (state.isRescanning) {
    state.hasPendingRescan = true;
    return;
  }

  state.isRescanning = true;
  try {
    await rescanLibrary(libraryId, true);
    syncLibraryWatcherDirectories(libraryId);
    notifyLibrariesAutoRefreshed({
      source: 'watch',
      silent: true,
      libraryId,
      reason
    });
  } catch (e) {
    console.warn('Library watcher rescan failed', libraryId, e?.message || e);
  } finally {
    state.isRescanning = false;
    if (state.hasPendingRescan) {
      state.hasPendingRescan = false;
      scheduleLibraryRescan(libraryId, 'pending');
    }
  }
}

function scheduleLibraryRescan(libraryId, reason = 'filesystem') {
  const state = libraryWatchers.get(libraryId);
  if (!state) return;
  state.lastReason = reason;
  if (state.rescanTimer) clearTimeout(state.rescanTimer);
  state.rescanTimer = setTimeout(() => {
    state.rescanTimer = null;
    runLibraryWatchRescan(libraryId, state.lastReason || reason);
  }, LIBRARY_WATCH_DEBOUNCE_MS);
}

function startLibraryWatcher(library) {
  if (!library?.id) return;

  stopLibraryWatcher(library.id);

  if (!isPhysicalLibrary(library)) return;
  if (!library.path || !isExistingDirectory(library.path)) return;

  libraryWatchers.set(library.id, {
    watchers: new Map(),
    rescanTimer: null,
    syncTimer: null,
    isRescanning: false,
    hasPendingRescan: false,
    lastReason: 'startup'
  });

  syncLibraryWatcherDirectories(library.id);
}

function restartAllLibraryWatchers() {
  for (const libraryId of [...libraryWatchers.keys()]) {
    stopLibraryWatcher(libraryId);
  }
  for (const library of appData.libraries || []) {
    startLibraryWatcher(library);
  }
}

function findNodeById(root, nodeId) {
  if (!root) return null;
  if (root.id === nodeId) return root;
  for (const child of root.children || []) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}

function removeBookFromNode(root, bookId) {
  if (!root) return;
  root.books = (root.books || []).filter(id => id !== bookId);
  (root.children || []).forEach(child => removeBookFromNode(child, bookId));
}

function getNodeAbsPath(library, node) {
  if (!library?.path) return null;
  if (node?.path) return node.path;
  const rel = node?.relPath || '';
  if (!rel) return library.path;
  return path.join(library.path, ...rel.split('/'));
}

function uniquePath(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  for (let i = 1; i < 5000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

function createFolder(libraryId, parentNodeId, folderName, createOnDisk = true) {
  const library = appData.libraries.find(l => l.id === libraryId);
  if (!library) throw new Error('Library not found');
  if (!isPhysicalLibrary(library)) throw new Error('Folders are only available for physical libraries');
  const parent = findNodeById(library.structure, parentNodeId);
  if (!parent) throw new Error('Target folder not found');

  const safeName = path.basename(String(folderName || '').trim());
  if (!safeName) throw new Error('Folder name is required');
  if (safeName === '.' || safeName === '..') throw new Error('Invalid folder name');

  const relPath = parent.relPath ? `${parent.relPath}/${safeName}` : safeName;
  const node = {
    id: hashPath(`node:${libraryId}:${relPath}`),
    name: safeName,
    path: library.path ? path.join(library.path, ...relPath.split('/')) : null,
    relPath,
    children: [],
    books: []
  };

  parent.children = parent.children || [];
  if (parent.children.some(c => c.name === safeName)) throw new Error('Folder already exists');
  parent.children.push(node);
  parent.children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (createOnDisk && library.path && node.path) {
    fs.mkdirSync(node.path, { recursive: true });
  }

  saveData();
  return node;
}

function moveBookToFolder(libraryId, bookId, targetNodeId, moveFile = false) {
  const library = appData.libraries.find(l => l.id === libraryId);
  if (!library) throw new Error('Library not found');
  if (!isPhysicalLibrary(library)) throw new Error('Move is only available in physical libraries');
  const book = appData.books[bookId];
  if (!book) throw new Error('Book not found');
  if (book.libraryId !== libraryId) throw new Error('Book is not in this library');

  const target = findNodeById(library.structure, targetNodeId);
  if (!target) throw new Error('Target folder not found');

  if (moveFile) {
    if (!library.path) throw new Error('This library is not backed by a folder on disk');
    const destDir = getNodeAbsPath(library, target);
    if (!destDir) throw new Error('Could not resolve destination folder');
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = uniquePath(path.join(destDir, path.basename(book.path)));
    fs.renameSync(book.path, destPath);
    book.path = destPath;
  }

  removeBookFromNode(library.structure, bookId);
  target.books = target.books || [];
  if (!target.books.includes(bookId)) target.books.push(bookId);

  saveData();
  return { success: true, book };
}

async function listSystemFonts() {
  const fallback = [
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Noto Sans',
    'Noto Serif',
    'DejaVu Sans',
    'DejaVu Serif',
    'Arial',
    'Times New Roman',
    'Courier New'
  ];

  const tryExec = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 6000, maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });

  try {
    if (process.platform === 'linux') {
      const out = await tryExec('fc-list', [':', 'family']);
      const fonts = new Set();
      out.split('\n').forEach(line => {
        const idx = line.indexOf(':');
        const fam = (idx >= 0 ? line.slice(idx + 1) : line).trim();
        fam.split(',').forEach(part => {
          const name = part.split(':')[0].trim();
          if (name) fonts.add(name);
        });
      });
      const list = [...fonts].sort((a, b) => a.localeCompare(b));
      return list.length ? list : fallback;
    }

    if (process.platform === 'darwin') {
      const out = await tryExec('system_profiler', ['SPFontsDataType']);
      const fonts = new Set();
      out.split('\n').forEach(line => {
        const m = line.match(/Full Name:\\s*(.+)\\s*$/);
        if (m?.[1]) fonts.add(m[1].trim());
      });
      const list = [...fonts].sort((a, b) => a.localeCompare(b));
      return list.length ? list : fallback;
    }
  } catch (e) {}

  return fallback;
}

function searchBooks(query) {
  const q = query.toLowerCase();
  return Object.values(appData.books).filter((b) => {
    if (!b || b.missingOnDisk) return false;
    const title = String(b.title || '').toLowerCase();
    const author = String(b.author || '').toLowerCase();
    return title.includes(q) || author.includes(q);
  });
}

async function readBookContent(id) {
  const book = appData.books[id];
  if (!book) return { chapters: [], toc: [], chapterIds: [], rawChapters: [] };

	if (book.format === 'epub') {
	  return new Promise((resolve) => {
	    const epub = new EPub(book.path);
	    epub.on('end', async () => {
	      currentEpub = epub;
	      const chapters = [];
	      const chapterIds = [];
	      const rawChapters = [];

	      const imageMap = {};
	      for (const [manifestId, item] of Object.entries(epub.manifest)) {
	        if (item['media-type'] && item['media-type'].startsWith('image/')) {
	          const href = String(item.href || '');
	          const base = href.split('/').pop();
	          if (href) {
	            imageMap[href] = manifestId;
	            imageMap[href.toLowerCase()] = manifestId;
	          }
	          if (base) {
	            imageMap[base] = manifestId;
	            imageMap[base.toLowerCase()] = manifestId;
	          }
	        }
	      }

	      const cssMap = {};
	      for (const [manifestId, item] of Object.entries(epub.manifest)) {
	        const mt = String(item?.['media-type'] || '');
	        if (mt.includes('css')) {
	          const href = String(item.href || '');
	          const base = href.split('/').pop();
	          if (href) {
	            cssMap[href] = manifestId;
	            cssMap[href.toLowerCase()] = manifestId;
	          }
	          if (base) {
	            cssMap[base] = manifestId;
	            cssMap[base.toLowerCase()] = manifestId;
	          }
	        }
	      }

	      const stripQueryFragment = (s) => {
	        const raw = String(s || '');
	        let decoded = raw;
	        try { decoded = decodeURIComponent(raw); } catch (e) {}
	        return decoded.split('#')[0].split('?')[0];
	      };

	      const normalizeWithinEpub = (href, baseHref) => {
	        const clean = stripQueryFragment(href).trim();
	        if (!clean) return '';
	        const noRoot = clean.replace(/^\/+/, '');
	        if (!baseHref) return path.posix.normalize(noRoot);
	        if (clean.startsWith('/')) return path.posix.normalize(noRoot);
	        const baseClean = stripQueryFragment(baseHref).replace(/^\/+/, '');
	        const baseDir = baseClean ? path.posix.dirname(baseClean) : '';
	        return path.posix.normalize(path.posix.join(baseDir, noRoot));
	      };

	      const resolveManifestIdFromSrc = (src, baseHref) => {
	        const s0 = String(src || '').trim();
	        if (!s0) return null;
	        if (/^(https?:|data:|blob:|mailto:|#)/i.test(s0)) return null;

	        const m = s0.match(/^\/(?:images|links)\/([^/]+)\//i);
	        if (m?.[1]) return m[1];

	        const normalized = stripQueryFragment(s0);
	        const base = normalized.split('/').pop();

	        const candidates = new Set();
	        candidates.add(normalized);
	        candidates.add(normalized.replace(/^\/+/, ''));
	        const joined = normalizeWithinEpub(normalized, baseHref);
	        if (joined) candidates.add(joined);
	        candidates.add(base);

	        for (const c of candidates) {
	          if (!c) continue;
	          const direct = imageMap[c] || imageMap[String(c).toLowerCase()];
	          if (direct) return direct;
	        }
	        return null;
	      };

	      const resolveCssIdFromHref = (href, baseHref) => {
	        const s0 = String(href || '').trim();
	        if (!s0) return null;
	        if (/^(https?:|data:|blob:|mailto:|#)/i.test(s0)) return null;
	        const normalized = stripQueryFragment(s0);
	        const base = normalized.split('/').pop();

	        const candidates = new Set();
	        candidates.add(normalized);
	        candidates.add(normalized.replace(/^\/+/, ''));
	        const joined = normalizeWithinEpub(normalized, baseHref);
	        if (joined) candidates.add(joined);
	        candidates.add(base);

	        for (const c of candidates) {
	          if (!c) continue;
	          const direct = cssMap[c] || cssMap[String(c).toLowerCase()];
	          if (direct) return direct;
	        }
	        return null;
	      };

	      const imageDataUrlByManifestId = new Map();
	      const getDataUrlForSrc = async (src, baseHref) => {
	        const manifestId = resolveManifestIdFromSrc(src, baseHref);
	        if (!manifestId) return null;
	        if (imageDataUrlByManifestId.has(manifestId)) return imageDataUrlByManifestId.get(manifestId);
	        try {
	          const [imgData, mimeType] = await new Promise((res, rej) => {
	            epub.getImage(manifestId, (err, data, mime) => err ? rej(err) : res([data, mime]));
	          });
	          if (!imgData || !mimeType) {
	            imageDataUrlByManifestId.set(manifestId, null);
	            return null;
	          }
	          const url = `data:${mimeType};base64,${imgData.toString('base64')}`;
	          imageDataUrlByManifestId.set(manifestId, url);
	          return url;
	        } catch (e) {
	          imageDataUrlByManifestId.set(manifestId, null);
	          return null;
	        }
	      };

	      const parseSrcset = (value) => {
	        const v = String(value || '').trim();
	        if (!v) return [];
	        return v.split(',').map(part => part.trim()).filter(Boolean).map((part) => {
	          const bits = part.split(/\s+/).filter(Boolean);
	          const url = bits[0] || '';
	          const desc = bits.slice(1).join(' ');
	          return { url, desc };
	        });
	      };

	      const rewriteImgSrcsetToSrc = async (html, baseHref) => {
	        const s = String(html || '');
	        const matches = [...s.matchAll(/<img\b[^>]*>/gi)];
	        if (matches.length === 0) return s;

	        let out = '';
	        let last = 0;
	        for (const m of matches) {
	          const tag = m[0];
	          const start = m.index ?? 0;
	          const end = start + tag.length;
	          out += s.slice(last, start);

	          let newTag = tag;
	          const srcsetMatch = tag.match(/\bsrcset=["']([^"']+)["']/i);
	          if (srcsetMatch?.[1]) {
	            const candidates = parseSrcset(srcsetMatch[1]);
	            let chosen = null;
	            for (let i = candidates.length - 1; i >= 0; i--) {
	              const u = candidates[i]?.url;
	              if (!u) continue;
	              const manifestId = resolveManifestIdFromSrc(u, baseHref);
	              if (manifestId) {
	                chosen = u;
	                break;
	              }
	            }
	            if (chosen) {
	              const dataUrl = await getDataUrlForSrc(chosen, baseHref);
	              if (dataUrl) {
	                if (/\bsrc=["'][^"']*["']/i.test(newTag)) {
	                  newTag = newTag.replace(/\bsrc=["'][^"']*["']/i, `src="${dataUrl}"`);
	                } else {
	                  newTag = newTag.replace(/^<img\b/i, `<img src="${dataUrl}"`);
	                }
	              }
	            }
	            newTag = newTag.replace(/\s+\bsrcset=["'][^"']*["']/i, '');
	            newTag = newTag.replace(/\s+\bsizes=["'][^"']*["']/i, '');
	          }

	          out += newTag;
	          last = end;
	        }
	        out += s.slice(last);
	        return out;
	      };

	      const replaceUrlsInCss = async (cssText, baseHref) => {
	        let out = String(cssText || '');
	        const cssUrlRegex = /url\((['"]?)([^'"\)]+)\1\)/gi;
	        const urls = new Set();
	        for (const m of out.matchAll(cssUrlRegex)) urls.add(m[2]);

	        const resolved = new Map();
	        for (const u of urls) {
	          const dataUrl = await getDataUrlForSrc(u, baseHref);
	          if (dataUrl) resolved.set(u, dataUrl);
	        }
	        if (resolved.size === 0) return out;
	        out = out.replace(cssUrlRegex, (m, q, src) => {
	          const replacement = resolved.get(src);
	          return replacement ? `url("${replacement}")` : m;
	        });
	        return out;
	      };

	      const sanitizeEpubCss = (cssText) => {
	        let out = String(cssText || '');
	        // Remove rules targeting html/body that could leak margin/padding to the app
	        out = out.replace(/(?:^|[},])\s*(html|body)\s*\{[^}]*\}/gi, (match) => {
	          // Extract just the selector part to check if it's a standalone html/body rule
	          const selectorMatch = match.match(/(?:^|[},])\s*(html|body)\s*\{/i);
	          if (selectorMatch) {
	            // Remove the entire rule block for standalone html/body selectors
	            return match.startsWith(',') ? '' : '';
	          }
	          return match;
	        });
	        // Also handle cases like "html, body { ... }" or "body, html { ... }"
	        out = out.replace(/(?:html\s*,\s*body|body\s*,\s*html)\s*\{[^}]*\}/gi, '');
	        // Remove @page rules that can affect layout
	        out = out.replace(/@page\s*\{[^}]*\}/gi, '');
	        // Remove any remaining standalone body/html selectors with properties
	        out = out.replace(/^\s*(?:html|body)\s*\{[^}]*\}\s*$/gim, '');
	        return out;
	      };

	      const inlineCssImports = async (cssText, baseHref, depth, visited) => {
	        if (depth >= 4) return String(cssText || '');
	        const s = String(cssText || '');
	        const importRegex = /@import\s+(?:url\(\s*)?(?:["'])([^"']+)(?:["'])\s*(?:\))?\s*;/gi;
	        const matches = [...s.matchAll(importRegex)];
	        if (matches.length === 0) return s;

	        let out = '';
	        let last = 0;
	        for (const m of matches) {
	          const start = m.index ?? 0;
	          const end = start + m[0].length;
	          out += s.slice(last, start);

	          const href = String(m[1] || '').trim();
	          const cssId = resolveCssIdFromHref(href, baseHref);
	          if (!cssId || visited.has(cssId)) {
	            out += m[0];
	            last = end;
	            continue;
	          }
	          visited.add(cssId);
	          try {
	            const [cssData] = await new Promise((res, rej) => {
	              epub.getFile(cssId, (err, data) => err ? rej(err) : res([data]));
	            });
	            const resolvedHref = normalizeWithinEpub(href, baseHref) || href;
	            let nested = String(cssData || '');
	            nested = await inlineCssImports(nested, resolvedHref, depth + 1, visited);
	            nested = await replaceUrlsInCss(nested, resolvedHref);
	            out += `/* @import ${href} */\n${nested}\n/* end @import */`;
	          } catch (e) {
	            out += m[0];
	          }

	          last = end;
	        }
	        out += s.slice(last);
	        return out;
	      };

	      const loadExternalCss = async (href, chapterHref) => {
	        const cssId = resolveCssIdFromHref(href, chapterHref);
	        if (!cssId) return '';
	        try {
	          const [cssData] = await new Promise((res, rej) => {
	            epub.getFile(cssId, (err, data) => err ? rej(err) : res([data]));
	          });
	          const resolvedHref = normalizeWithinEpub(href, chapterHref) || href;
	          let cssText = String(cssData || '');
	          cssText = await inlineCssImports(cssText, resolvedHref, 0, new Set([cssId]));
	          cssText = await replaceUrlsInCss(cssText, resolvedHref);
	          cssText = sanitizeEpubCss(cssText);
	          return cssText;
	        } catch (e) {
	          return '';
	        }
	      };

	      const replaceImagesInHtml = async (html, baseHref) => {
	        let out = String(html || '');
	        out = await rewriteImgSrcsetToSrc(out, baseHref);

	        const imgSrcRegex = /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi;
	        const embedSrcRegex = /(<embed\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi;
	        const objectDataRegex = /(<object\b[^>]*?\bdata=["'])([^"']+)(["'][^>]*>)/gi;
	        const svgHrefRegex = /(<image\b[^>]*?\b(?:xlink:href|href)=["'])([^"']+)(["'][^>]*>)/gi;
	        const cssUrlRegex = /url\((['"]?)([^'"\)]+)\1\)/gi;

	        const srcs = new Set();
	        for (const m of out.matchAll(imgSrcRegex)) srcs.add(m[2]);
	        for (const m of out.matchAll(embedSrcRegex)) srcs.add(m[2]);
	        for (const m of out.matchAll(objectDataRegex)) srcs.add(m[2]);
	        for (const m of out.matchAll(svgHrefRegex)) srcs.add(m[2]);
	        for (const m of out.matchAll(cssUrlRegex)) srcs.add(m[2]);

	        const resolved = new Map();
	        const unresolved = new Set();
	        for (const src of srcs) {
	          if (/^(data:|blob:)/i.test(src)) {
	            resolved.set(src, src);
	          } else {
	            const dataUrl = await getDataUrlForSrc(src, baseHref);
	            if (dataUrl) resolved.set(src, dataUrl);
	            else unresolved.add(src);
	          }
	        }

	        const replacer = (m, prefix, src, suffix) => {
	          const replacement = resolved.get(src);
	          if (replacement) return `${prefix}${replacement}${suffix}`;
	          if (unresolved.has(src)) return '';
	          return m;
	        };
	        out = out.replace(imgSrcRegex, replacer);
	        out = out.replace(embedSrcRegex, replacer);
	        out = out.replace(objectDataRegex, replacer);
	        out = out.replace(svgHrefRegex, replacer);
	        out = out.replace(cssUrlRegex, (m, q, src) => {
	          const replacement = resolved.get(src);
	          return replacement ? `url("${replacement}")` : m;
	        });
	        return out;
	      };

	      const extractRenderableFragment = async (xhtml, baseHref) => {
	        const s = String(xhtml || '');
	        const bodyMatch = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
	        const bodyInner = bodyMatch?.[1] ? bodyMatch[1] : s;

	        const inlineStyleTags = [...s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
	        const sanitizedInlineStyles = inlineStyleTags.map(m => {
	          const cssContent = sanitizeEpubCss(m[1] || '');
	          return `<style>${cssContent}</style>`;
	        }).join('\n');
	        const linkTags = [...s.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)].map(m => m[0]);
	        const hrefs = linkTags.map(tag => {
	          const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
	          return hrefMatch?.[1] || '';
	        }).filter(Boolean);

	        const externalStyles = [];
	        for (const href of hrefs) {
	          const cssText = await loadExternalCss(href, baseHref);
	          if (cssText) externalStyles.push(`<style>${cssText}</style>`);
	        }

	        return `${sanitizedInlineStyles}\n${externalStyles.join('\n')}\n${bodyInner}`;
	      };

	      for (const ch of epub.flow) {
	        chapterIds.push(ch.href || ch.id);
	        try {
	          let text = await new Promise((res, rej) => {
	            epub.getChapterRaw(ch.id, (err, data) => err ? rej(err) : res(data));
	          });
	          rawChapters.push(text);

	          const baseHref = ch.href || ch.id || '';
	          text = await extractRenderableFragment(text, baseHref);
	          text = await replaceImagesInHtml(text, baseHref);
	          chapters.push(text);
	        } catch (e) { chapters.push(''); rawChapters.push(''); }
	      }

        const chapterIndexByBase = new Map();
        chapterIds.forEach((cid, idx) => {
          const c = decodeURIComponent(String(cid || '')).split('#')[0].split('?')[0];
          const base = c.split('/').pop();
          if (base && !chapterIndexByBase.has(base)) chapterIndexByBase.set(base, idx);
        });

        // Recursively flatten nested TOC while preserving level
        function flattenToc(items, level = 0) {
          const result = [];
          for (const t of items) {
            const hrefFull = String(t.href || '');
            const hrefPath = decodeURIComponent(hrefFull.split('#')[0]).split('?')[0];
            const base = hrefPath.split('/').pop();
            let chapterIndex = (base && chapterIndexByBase.has(base)) ? chapterIndexByBase.get(base) : -1;
            if (chapterIndex === -1) {
              chapterIndex = result.length < chapterIds.length ? result.length : 0;
            }
            result.push({ title: t.title || `Chapter ${result.length + 1}`, href: t.href, chapterIndex, level: t.level || 0 });
            if (t.subitems && t.subitems.length) {
              result.push(...flattenToc(t.subitems, level + 1));
            }
          }
          return result;
        }

        let toc = flattenToc(epub.toc || []);
        if (!toc.length) {
          toc = chapterIds.map((cid, idx) => ({
            title: `Chapter ${idx + 1}`,
            href: cid,
            chapterIndex: idx,
            level: 0
          }));
        }

        resolve({ chapters, toc, chapterIds, rawChapters });
      });
      epub.on('error', () => resolve({ chapters: [], toc: [], chapterIds: [], rawChapters: [] }));
      epub.parse();
    });
  } else if (book.format === 'pdf') {
    const buffer = fs.readFileSync(book.path);
    if (typeof PDFParse !== 'function') throw new TypeError('PDFParse is not available');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const pdfData = buffer.toString('base64');
      return {
        chapters: [],
        toc: [],
        chapterIds: [],
        rawChapters: [result.text],
        pdfData,
        pageCount: result.numpages || 1
      };
    } finally {
      try { await parser.destroy(); } catch (e) {}
    }
  } else if (book.format === 'txt') {
    const text = readTextFileBestEffort(book.path);
    const fallbackTitle = book.title || path.basename(book.path || '', path.extname(book.path || ''));
    return buildTxtContentWithToc(text, fallbackTitle);
  } else if (book.format === 'md') {
    const markdown = readTextFileBestEffort(book.path);
    const fallbackTitle = book.title || path.basename(book.path || '', path.extname(book.path || ''));
    return buildMarkdownContentWithToc(markdown, fallbackTitle, book.path || '');
  }
  return { chapters: [], toc: [], chapterIds: [], rawChapters: [] };
}

function getCoversDir() {
  const dir = path.join(roseDataDir, 'covers');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

async function ensureEpubCover(bookId) {
  const book = appData.books[bookId];
  if (!book || book.format !== 'epub') return null;
  const coversDir = getCoversDir();

  if (book.coverFile) {
    const existing = path.join(coversDir, book.coverFile);
    try {
      if (fs.existsSync(existing) && fs.statSync(existing).size > 0) return existing;
    } catch (e) {}
  }

  const coverInfo = await new Promise((resolve) => {
    const epub = new EPub(book.path);
    epub.on('end', async () => {
      try {
        const manifest = epub.manifest || {};
        const metaCover = epub.metadata?.cover || epub.metadata?.['cover'] || epub.metadata?.['cover-image'];

        const candidates = [];
        if (metaCover) {
          if (manifest[metaCover]) candidates.push(metaCover);
          const metaStr = String(metaCover);
          for (const [id, item] of Object.entries(manifest)) {
            const href = String(item?.href || '');
            if (href === metaStr || href.endsWith('/' + metaStr) || href.endsWith(metaStr)) candidates.push(id);
          }
        }

        for (const [id, item] of Object.entries(manifest)) {
          const href = String(item?.href || '');
          const mt = String(item?.['media-type'] || '');
          const props = String(item?.properties || '');
          if (!mt.startsWith('image/')) continue;
          if (props.includes('cover-image')) candidates.push(id);
          else if (id.toLowerCase().includes('cover')) candidates.push(id);
          else if (href.toLowerCase().includes('cover')) candidates.push(id);
        }

        const imageMap = {};
        for (const [manifestId, item] of Object.entries(manifest)) {
          const mt = String(item?.['media-type'] || '');
          if (!mt.startsWith('image/')) continue;
          const href = String(item?.href || '');
          imageMap[href] = manifestId;
          imageMap[href.replace(/^\.\//, '')] = manifestId;
          imageMap[href.replace(/^\//, '')] = manifestId;
          imageMap[href.split('/').pop()] = manifestId;
        }

        const candidatesOrdered = [];
        const seen = new Set();
        for (const c of candidates) {
          if (!c || seen.has(c)) continue;
          seen.add(c);
          candidatesOrdered.push(c);
        }

        let coverId = candidatesOrdered.find((id) => {
          const mt = String(manifest[id]?.['media-type'] || '');
          return mt.startsWith('image/');
        });
        if (!coverId) {
          const coverPageIds = candidatesOrdered.filter((id) => {
            const mt = String(manifest[id]?.['media-type'] || '');
            return mt.includes('html');
          });

          for (const coverPageId of coverPageIds) {
            try {
              const html = await new Promise((res, rej) => {
                epub.getChapterRaw(coverPageId, (err, data) => err ? rej(err) : res(String(data || '')));
              });
              const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
              for (const match of imgs) {
                const src = String(match[1] || '');
                const variations = [src, src.replace(/^\.\.\//, ''), src.replace(/^\.\//, ''), src.replace(/^\//, ''), src.split('/').pop()];
                const hit = variations.map(v => imageMap[v]).find(Boolean);
                if (hit) { coverId = hit; break; }
              }
              if (coverId) break;
            } catch (e) {}
          }
        }

        if (!coverId) {
          const chaptersToCheck = (epub.flow || []).slice(0, 10);
          for (const ch of chaptersToCheck) {
            try {
              const html = await new Promise((res, rej) => {
                epub.getChapterRaw(ch.id, (err, data) => err ? rej(err) : res(String(data || '')));
              });
              const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
              for (const match of imgs) {
                const src = String(match[1] || '');
                const variations = [src, src.replace(/^\.\.\//, ''), src.replace(/^\.\//, ''), src.replace(/^\//, ''), src.split('/').pop()];
                const hit = variations.map(v => imageMap[v]).find(Boolean);
                if (hit) { coverId = hit; break; }
              }
              if (coverId) break;
            } catch (e) {}
          }
        }

        if (!coverId) return resolve(null);

        const [imgData, mimeType] = await new Promise((res, rej) => {
          epub.getImage(coverId, (err, data, mime) => err ? rej(err) : res([data, mime]));
        });
        if (!imgData || !mimeType) return resolve(null);

        const ext = mimeType === 'image/png'
          ? 'png'
          : (mimeType === 'image/jpeg'
            ? 'jpg'
            : (mimeType === 'image/webp'
              ? 'webp'
              : (mimeType === 'image/gif'
                ? 'gif'
                : (mimeType === 'image/svg+xml' ? 'svg' : 'bin'))));
        const fileName = `${bookId}.${ext}`;
        const abs = path.join(coversDir, fileName);
        fs.writeFileSync(abs, imgData);
        book.coverFile = fileName;
        book.coverMime = mimeType;
        saveData();
        resolve(abs);
      } catch (e) {
        resolve(null);
      }
    });
    epub.on('error', () => resolve(null));
    epub.parse();
  });

  return coverInfo;
}

async function ensurePdfCover(bookId) {
  const book = appData.books[bookId];
  if (!book || book.format !== 'pdf') return null;
  const coversDir = getCoversDir();

  if (book.coverFile) {
    const existing = path.join(coversDir, book.coverFile);
    try {
      if (fs.existsSync(existing) && fs.statSync(existing).size > 0) return existing;
    } catch (e) {}
    // Cover file is set but doesn't exist or is empty, clear it and regenerate
    book.coverFile = null;
    book.coverMime = null;
  }

  const fileName = `${bookId}.png`;
  const abs = path.join(coversDir, fileName);

  // Use pdftoppm (poppler-utils) to render first page
  try {
    const outputBase = path.join(coversDir, `${bookId}-tmp`);
    const pdfPath = path.resolve(book.path);

    // Check if PDF file exists
    if (!fs.existsSync(pdfPath)) {
      console.warn('PDF file not found:', pdfPath);
      return null;
    }

    const pdftoppmCmd = fs.existsSync('/usr/bin/pdftoppm') ? '/usr/bin/pdftoppm' : 'pdftoppm';

    await new Promise((resolve, reject) => {
      execFile(pdftoppmCmd, [
        '-png', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '520',
        pdfPath, outputBase
      ], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          console.warn('pdftoppm error:', err.message, stderr);
          reject(err);
        }
        else resolve();
      });
    });

    // With -singlefile, output is exactly outputBase.png
    const tmpFile = `${outputBase}.png`;
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
      fs.renameSync(tmpFile, abs);
      book.coverFile = fileName;
      book.coverMime = 'image/png';
      saveData();
      return abs;
    }
  } catch (e) {
    console.warn('Failed to generate PDF cover for', book.title, ':', e.message);
  }

  return null;
}

async function getCoverUrl(bookId) {
  const book = appData.books[bookId];
  if (!book) return null;
  if (book.format !== 'epub' && book.format !== 'pdf') return null;

  const coversDir = getCoversDir();
  const fileName = book.coverFile ? path.join(coversDir, book.coverFile) : null;
  const absPath = (fileName && fs.existsSync(fileName))
    ? fileName
    : (book.format === 'pdf' ? await ensurePdfCover(bookId) : await ensureEpubCover(bookId));
  if (!absPath) return null;
  return pathToFileURL(absPath).toString();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    title: 'RoseReader',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      plugins: true,
      backgroundThrottling: false
    }
  });
  // Set WM class for Wayland/Linux icon support
  if (process.platform === 'linux') {
    try {
      mainWindow.setTitle('RoseReader');
    } catch (e) {}
  }
  try { mainWindow.webContents.setBackgroundThrottling(false); } catch (e) {}
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  loadData();
  restartAllLibraryWatchers();
  createWindow();
  if (mainWindow?.webContents) {
    mainWindow.webContents.once('did-finish-load', () => {
      autoRefreshLibrariesOnLaunch().catch((e) => {
        console.warn('Auto refresh on launch failed:', e?.message || e);
      });
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const libraryId of [...libraryWatchers.keys()]) {
    stopLibraryWatcher(libraryId);
  }
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.filePaths[0] || null;
});

ipcMain.handle('show-open-dialog', async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options || {});
  return result.filePaths || [];
});

ipcMain.handle('show-save-dialog', async (_, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options || {});
  return result.filePath || null;
});

ipcMain.handle('create-library', async (_, name, dirPath) => createLibrary(name, dirPath));
ipcMain.handle('create-empty-library', async (_, name) => createEmptyLibrary(name));
ipcMain.handle('delete-library', (_, id, deleteMode) => deleteLibrary(id, deleteMode));
ipcMain.handle('rescan-library', async (_, id, patchOnly) => rescanLibrary(id, patchOnly));
ipcMain.handle('create-folder', (_, libraryId, parentNodeId, folderName, createOnDisk) =>
  createFolder(libraryId, parentNodeId, folderName, createOnDisk)
);
ipcMain.handle('move-book', (_, libraryId, bookId, targetNodeId, moveFile) =>
  moveBookToFolder(libraryId, bookId, targetNodeId, moveFile)
);
ipcMain.handle('add-book-to-library', (_, libraryId, bookId) =>
  addBookToLogicalLibrary(libraryId, bookId)
);
ipcMain.handle('remove-book-from-library', (_, libraryId, bookId) =>
  removeBookFromLogicalLibrary(libraryId, bookId)
);
ipcMain.handle('merge-moved-book-state', () => {
  const markedMissing = markBooksMissingForUnavailableLibraries(true);
  const mergedCount = recoverMovedBookProgress();
  const syncedCount = synchronizeDuplicateBookProgress();
  const dedupedCount = mergeDuplicateBooks();
  if (markedMissing > 0 || mergedCount > 0 || syncedCount > 0 || dedupedCount > 0) saveData();
  return { mergedCount, dedupedCount };
});
ipcMain.handle('list-system-fonts', async () => listSystemFonts());
ipcMain.handle('get-system-locale', () => ({
  locale: app.getLocale?.() || 'en-US',
  languages: app.getPreferredSystemLanguages?.() || []
}));
ipcMain.handle('get-cover-url', async (_, bookId) => getCoverUrl(bookId));
ipcMain.handle('regenerate-cover', async (_, bookId) => {
  const book = appData.books[bookId];
  if (!book) return null;
  // Clear existing cover to force regeneration
  if (book.coverFile) {
    const coversDir = getCoversDir();
    const existing = path.join(coversDir, book.coverFile);
    try { fs.unlinkSync(existing); } catch (e) {}
    book.coverFile = null;
    book.coverMime = null;
    saveData();
  }
  return getCoverUrl(bookId);
});
ipcMain.handle('get-libraries', () => appData.libraries);
ipcMain.handle('get-books', () => Object.values(appData.books));
ipcMain.handle('get-book', (_, id) => appData.books[id]);
ipcMain.handle('read-book', (_, id) => readBookContent(id));
ipcMain.handle('delete-book', (_, id, deleteFile) => deleteBook(id, deleteFile));
ipcMain.handle('search-books', (_, query) => searchBooks(query));
ipcMain.handle('get-settings', () => appData.settings);
ipcMain.handle('update-settings', (_, settings) => { appData.settings = settings; saveData(); });
ipcMain.handle('mark-book-reading-start', (_, id, startedAt = Date.now()) =>
  markBookReadingStart(id, startedAt)
);
ipcMain.handle('get-book-metainfo', (_, id) => getBookMetainfo(id));
ipcMain.handle('update-progress', (_, id, progress, timeSpent = 0, progressChapter = 0, progressOffset = 0, epubLocation = null) => {
  if (appData.books[id]) {
    const now = Date.now();

    appData.books[id].progress = progress;
    appData.books[id].progressChapter = progressChapter;
    appData.books[id].progressOffset = progressOffset;

    if (epubLocation && typeof epubLocation === 'object') {
      const href = typeof epubLocation.href === 'string' ? epubLocation.href : '';
      const ratio = Number(epubLocation.ratio);
      const anchor = typeof epubLocation.anchor === 'string' ? epubLocation.anchor : '';
      const anchorDeltaRaw = Number(epubLocation.anchorDelta);
      const anchorDelta = Number.isFinite(anchorDeltaRaw)
        ? Math.max(-4000, Math.min(4000, anchorDeltaRaw))
        : null;
      if (href && Number.isFinite(ratio)) {
        appData.books[id].epubLocation = {
          href,
          ratio: Math.max(0, Math.min(1, ratio)),
          anchor: anchor || '',
          anchorDelta,
          updatedAt: Date.now()
        };
      }
    }

    const hasReadingSignal = Number(progress || 0) > 0
      || Number(timeSpent || 0) > 0
      || Number(progressChapter || 0) > 0
      || Number(progressOffset || 0) > 0
      || (epubLocation && typeof epubLocation === 'object');
    if (hasReadingSignal && (!appData.books[id].firstReadAt || Number(appData.books[id].firstReadAt) <= 0)) {
      appData.books[id].firstReadAt = now;
    }

    appData.books[id].lastRead = now;
    if (progress >= 0.98) {
      if (!appData.books[id].firstCompletedAt) {
        appData.books[id].firstCompletedAt = now;
        appData.stats.booksRead += 1;
      }
      if (!appData.books[id].completedAt && appData.books[id].firstCompletedAt) {
        appData.books[id].completedAt = appData.books[id].firstCompletedAt;
      }
    }
    if (timeSpent > 0) {
      appData.books[id].timeSpent = (appData.books[id].timeSpent || 0) + timeSpent;
      appData.stats.totalReadTime += timeSpent;
      try {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const key = `${y}-${m}-${day}`;
        if (!appData.analytics) appData.analytics = { ...defaultAnalytics };
        if (!appData.analytics.daily) appData.analytics.daily = {};
        appData.analytics.daily[key] = (appData.analytics.daily[key] || 0) + Number(timeSpent || 0);
        appData.analytics.updatedAt = Date.now();
      } catch (e) {}
    }
    synchronizeDuplicateBookProgress([id]);
    saveData();
  }
});
ipcMain.handle('update-book', (_, id, patch) => {
  if (appData.books[id]) {
    Object.assign(appData.books[id], patch);
    saveData();
  }
});
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
ipcMain.handle('show-item-in-folder', (_, filePath) => {
  if (!filePath) return;
  try { shell.showItemInFolder(filePath); } catch (e) {}
});
ipcMain.handle('import-directory', async (_, dirPath) => createLibrary(path.basename(dirPath), dirPath));
ipcMain.handle('get-library', () => appData.libraries.map(l => l.structure));
ipcMain.handle('get-state', () => ({
  libraries: appData.libraries,
  libraryBookMap: appData.libraryBookMap || {},
  books: Object.values(appData.books),
  settings: appData.settings,
  stats: appData.stats,
  analytics: appData.analytics
}));
ipcMain.handle('search-in-book', async (_, bookId, query) => {
  const book = appData.books[bookId];
  if (!book) return [];
  const content = await readBookContent(bookId);
  const results = [];
  const q = query.toLowerCase();
  content.rawChapters.forEach((text, chapterIndex) => {
    const lines = text.split('\n');
    lines.forEach((line, lineIndex) => {
      if (line.toLowerCase().includes(q)) {
        results.push({ chapterIndex, lineIndex, text: line.trim().slice(0, 200), chapterId: content.chapterIds[chapterIndex] });
      }
    });
  });
  return results.slice(0, 2000);
});
ipcMain.handle('export-data', async (_, filePath) => exportData(filePath));
ipcMain.handle('import-data', async (_, filePath) => importData(filePath));
ipcMain.handle('get-stats', () => appData.stats);
ipcMain.handle('get-bookmarks', (_, bookId) => appData.bookmarks[bookId] || []);
ipcMain.handle('add-bookmark', (_, bookId, bookmark) => {
  if (!appData.bookmarks[bookId]) appData.bookmarks[bookId] = [];
  bookmark.id = Date.now().toString(36);
  bookmark.timestamp = Date.now();
  appData.bookmarks[bookId].push(bookmark);
  saveData();
  return bookmark;
});
ipcMain.handle('delete-bookmark', (_, bookId, bookmarkId) => {
  if (appData.bookmarks[bookId]) {
    appData.bookmarks[bookId] = appData.bookmarks[bookId].filter(b => b.id !== bookmarkId);
    saveData();
  }
});
ipcMain.handle('get-highlights', (_, bookId) => appData.highlights[bookId] || []);
ipcMain.handle('add-highlight', (_, bookId, highlight) => {
  if (!appData.highlights[bookId]) appData.highlights[bookId] = [];
  highlight.id = Date.now().toString(36);
  highlight.timestamp = Date.now();
  appData.highlights[bookId].push(highlight);
  saveData();
  return highlight;
});
ipcMain.handle('delete-highlight', (_, bookId, highlightId) => {
  if (appData.highlights[bookId]) {
    appData.highlights[bookId] = appData.highlights[bookId].filter(h => h.id !== highlightId);
    saveData();
  }
});
ipcMain.handle('update-highlight-color', (_, bookId, highlightId, newColor) => {
  if (appData.highlights[bookId]) {
    const highlight = appData.highlights[bookId].find(h => h.id === highlightId);
    if (highlight) {
      highlight.color = newColor;
      saveData();
      return highlight;
    }
  }
  return null;
});

ipcMain.handle('get-notes', (_, bookId) => appData.notes[bookId] || []);
ipcMain.handle('add-note', (_, bookId, note) => {
  if (!appData.notes[bookId]) appData.notes[bookId] = [];
  note.id = Date.now().toString(36);
  note.timestamp = Date.now();
  appData.notes[bookId].push(note);
  saveData();
  return note;
});
ipcMain.handle('update-note', (_, bookId, noteId, patch) => {
  const list = appData.notes[bookId] || [];
  const idx = list.findIndex(n => n.id === noteId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...(patch || {}), updatedAt: Date.now() };
    appData.notes[bookId] = list;
    saveData();
    return list[idx];
  }
  return null;
});
ipcMain.handle('delete-note', (_, bookId, noteId) => {
  if (appData.notes[bookId]) {
    appData.notes[bookId] = appData.notes[bookId].filter(n => n.id !== noteId);
    saveData();
  }
});

ipcMain.handle('toggle-pin', (_, bookId) => {
  const b = appData.books[bookId];
  if (!b) return null;
  if (b.pinnedAt) delete b.pinnedAt;
  else b.pinnedAt = Date.now();
  saveData();
  return { id: bookId, pinnedAt: b.pinnedAt || null };
});
