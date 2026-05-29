const SEARCH_INDEX_VERSION = 1;
const DEFAULT_SEARCH_LIMIT = 1000;
const MAX_SEARCH_LIMIT = 5000;

function normalizeLineBreaks(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function normalizePlainText(value) {
  return normalizeLineBreaks(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const name = String(entity || '').toLowerCase();
    const named = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' '
    };
    if (Object.prototype.hasOwnProperty.call(named, name)) return named[name];
    if (name.startsWith('#x')) {
      const code = parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function htmlToPlainText(html) {
  return normalizePlainText(decodeHtmlEntities(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ));
}

function markdownToPlainText(markdown) {
  return normalizePlainText(String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, ''));
}

function textForChapter(format, renderedChapter, rawChapter) {
  const rendered = String(renderedChapter || '');
  if (rendered && /<[^>]+>/.test(rendered)) return htmlToPlainText(rendered);
  if (format === 'epub') return htmlToPlainText(rawChapter);
  if (format === 'md') return markdownToPlainText(rawChapter);
  return normalizePlainText(rawChapter);
}

function cloneSignature(signature) {
  if (!signature || typeof signature !== 'object') return null;
  return {
    sizeBytes: Number(signature.sizeBytes || 0),
    modifiedAt: Number(signature.modifiedAt || 0),
    fingerprint: signature.fingerprint || null
  };
}

function isSameSignature(left, right) {
  if (!left || !right) return false;
  const leftSize = Number(left.sizeBytes);
  const rightSize = Number(right.sizeBytes);
  if (!Number.isFinite(leftSize) || !Number.isFinite(rightSize) || leftSize !== rightSize) return false;

  const leftModified = Number(left.modifiedAt);
  const rightModified = Number(right.modifiedAt);
  if (!Number.isFinite(leftModified) || !Number.isFinite(rightModified)) return false;
  if (Math.abs(leftModified - rightModified) >= 1) return false;

  const leftFingerprint = String(left.fingerprint || '').trim();
  const rightFingerprint = String(right.fingerprint || '').trim();
  if (leftFingerprint || rightFingerprint) return !!leftFingerprint && leftFingerprint === rightFingerprint;
  return true;
}

function titleForChapter(toc, chapterIndex, fallback) {
  const item = Array.isArray(toc)
    ? toc.find(entry => Number(entry?.chapterIndex) === chapterIndex)
    : null;
  const title = String(item?.title || '').trim();
  return title || fallback || `Chapter ${chapterIndex + 1}`;
}

function sanitizeSection(section, fallbackKind = 'chapter') {
  if (!section || typeof section !== 'object') return null;
  const text = normalizePlainText(section.text || '');
  if (!text) return null;

  const kind = section.kind === 'page' ? 'page' : fallbackKind;
  const out = {
    kind,
    text
  };

  if (kind === 'page') {
    const pageNum = Math.max(1, Math.floor(Number(section.pageNum || 1)));
    out.pageNum = pageNum;
    out.title = String(section.title || `Page ${pageNum}`).trim();
  } else {
    const chapterIndex = Math.max(0, Math.floor(Number(section.chapterIndex || 0)));
    out.chapterIndex = chapterIndex;
    out.title = String(section.title || `Chapter ${chapterIndex + 1}`).trim();
    out.href = String(section.href || '').trim();
  }

  return out;
}

function sanitizeSearchIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return null;
  const type = String(index.type || '').trim().toLowerCase();
  if (!type) return null;
  const version = Number(index.version || 0);
  if (version !== SEARCH_INDEX_VERSION) return null;

  const fallbackKind = type === 'pdf' ? 'page' : 'chapter';
  const sections = (Array.isArray(index.sections) ? index.sections : [])
    .map(section => sanitizeSection(section, fallbackKind))
    .filter(Boolean);
  if (!sections.length) return null;

  const totalChars = sections.reduce((sum, section) => sum + section.text.length, 0);
  return {
    type,
    version: SEARCH_INDEX_VERSION,
    source: index.source || 'reader-content',
    generatedAt: Number(index.generatedAt || Date.now()),
    signature: cloneSignature(index.signature),
    sectionCount: sections.length,
    totalChars,
    sections
  };
}

function buildSearchIndexFromContent({
  format,
  signature = null,
  toc = [],
  chapterIds = [],
  rawChapters = [],
  chapters = [],
  pdfPages = []
} = {}) {
  const type = String(format || '').trim().toLowerCase();
  const sections = [];

  if (type === 'pdf') {
    const pages = Array.isArray(pdfPages) && pdfPages.length
      ? pdfPages
      : [{ pageNum: 1, text: Array.isArray(rawChapters) ? rawChapters.join('\n\n') : '' }];
    for (const page of pages) {
      const pageNum = Math.max(1, Math.floor(Number(page?.pageNum || page?.num || sections.length + 1)));
      const text = normalizePlainText(page?.text || '');
      if (!text) continue;
      sections.push({ kind: 'page', pageNum, title: `Page ${pageNum}`, text });
    }
  } else {
    const count = Math.max(
      Array.isArray(rawChapters) ? rawChapters.length : 0,
      Array.isArray(chapters) ? chapters.length : 0,
      Array.isArray(chapterIds) ? chapterIds.length : 0
    );
    for (let chapterIndex = 0; chapterIndex < count; chapterIndex += 1) {
      const text = textForChapter(type, chapters?.[chapterIndex], rawChapters?.[chapterIndex]);
      if (!text) continue;
      sections.push({
        kind: 'chapter',
        chapterIndex,
        title: titleForChapter(toc, chapterIndex),
        href: String(chapterIds?.[chapterIndex] || '').trim(),
        text
      });
    }
  }

  return sanitizeSearchIndex({
    type,
    version: SEARCH_INDEX_VERSION,
    source: 'reader-content',
    generatedAt: Date.now(),
    signature,
    sections
  });
}

function isReusableSearchIndex(index, format, signature) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return false;
  if (Number(index.version || 0) !== SEARCH_INDEX_VERSION) return false;
  if (!Array.isArray(index.sections) || !index.sections.length) return false;
  if (String(index.type || '').trim().toLowerCase() !== String(format || '').trim().toLowerCase()) return false;
  return isSameSignature(index.signature, signature);
}

function normalizeQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function makeSnippet(text, index, length, context = 48) {
  const raw = String(text || '');
  const start = Math.max(0, index - context);
  const end = Math.min(raw.length, index + length + context);
  let snippet = raw.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < raw.length) snippet = `${snippet}...`;
  return snippet;
}

function normalizeLimit(limit) {
  const n = Math.floor(Number(limit || DEFAULT_SEARCH_LIMIT));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, n);
}

function getSearchableIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return null;
  const type = String(index.type || '').trim().toLowerCase();
  if (!type || Number(index.version || 0) !== SEARCH_INDEX_VERSION) return null;
  const sections = (Array.isArray(index.sections) ? index.sections : [])
    .filter(section => section && typeof section === 'object' && String(section.text || '').length > 0);
  if (!sections.length) return null;
  return { type, sections };
}

function searchPersistedIndex(index, query, options = {}) {
  const safe = getSearchableIndex(index);
  const q = normalizeQuery(query);
  if (!safe || !q) return [];

  const limit = normalizeLimit(options.limit);
  const results = [];
  const sectionCount = Math.max(1, safe.sections.length);

  for (let sectionIndex = 0; sectionIndex < safe.sections.length; sectionIndex += 1) {
    const section = safe.sections[sectionIndex];
    const text = String(section.text || '');
    const lower = text.toLowerCase();
    let from = 0;
    let occurrence = 0;

    while (results.length < limit) {
      const idx = lower.indexOf(q, from);
      if (idx === -1) break;
      const posInSection = text.length ? (idx / text.length) : 0;
      const kind = section.kind === 'page' ? 'page' : 'chapter';
      const base = {
        type: safe.type,
        sectionIndex,
        kind,
        title: section.title || '',
        charIndex: idx,
        charLength: q.length,
        snippet: makeSnippet(text, idx, q.length),
        pos: Math.max(0, Math.min(1, (sectionIndex + posInSection) / sectionCount))
      };

      if (kind === 'page') {
        const pageNumRaw = Number(section.pageNum || 1);
        const pageNum = Number.isFinite(pageNumRaw) ? Math.max(1, Math.floor(pageNumRaw)) : 1;
        results.push({
          ...base,
          pageNum,
          occurrenceInPage: occurrence
        });
      } else {
        const chapterIndexRaw = Number(section.chapterIndex || 0);
        const chapterIndex = Number.isFinite(chapterIndexRaw) ? Math.max(0, Math.floor(chapterIndexRaw)) : 0;
        results.push({
          ...base,
          chapterIndex,
          chapterId: section.href || `chapter-${chapterIndex}`,
          occurrenceInChapter: occurrence
        });
      }

      occurrence += 1;
      from = idx + Math.max(1, q.length);
    }

    if (results.length >= limit) break;
  }

  return results;
}

function summarizeSearchIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return null;
  const type = String(index.type || '').trim().toLowerCase();
  if (!type || Number(index.version || 0) !== SEARCH_INDEX_VERSION) return null;
  const sections = Array.isArray(index.sections) ? index.sections : [];
  if (!sections.length) return null;
  const sectionCountRaw = Number(index.sectionCount);
  const totalCharsRaw = Number(index.totalChars);
  return {
    type,
    version: SEARCH_INDEX_VERSION,
    source: index.source || 'reader-content',
    generatedAt: Number(index.generatedAt || 0),
    sectionCount: Number.isFinite(sectionCountRaw) && sectionCountRaw > 0 ? sectionCountRaw : sections.length,
    totalChars: Number.isFinite(totalCharsRaw) && totalCharsRaw >= 0 ? totalCharsRaw : 0
  };
}

module.exports = {
  SEARCH_INDEX_VERSION,
  buildSearchIndexFromContent,
  isReusableSearchIndex,
  sanitizeSearchIndex,
  searchPersistedIndex,
  summarizeSearchIndex
};
