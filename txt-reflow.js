/**
 * txt-reflow.js — 纯文本 → 阅读用 HTML（智能重排）。
 * 纯函数、无 Electron 依赖，便于单测。
 */

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// 宽字符（CJK / 假名 / 全角 / 表意空格与标点等）显示宽度记 2。
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〿぀-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

function displayWidth(str) {
  let width = 0;
  for (const ch of String(str || '')) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
  }
  return width;
}

function estimateWrapWidth(lines) {
  const widths = (Array.isArray(lines) ? lines : [])
    .map(displayWidth)
    .filter(w => w > 0)
    .sort((a, b) => a - b);
  if (widths.length < 3) return Infinity;
  const idx = Math.floor(0.85 * (widths.length - 1));
  const w = widths[idx];
  return w >= 20 ? w : Infinity;
}

function segmentBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    if (String(raw).trim() === '') {
      if (current.length) { blocks.push(current); current = []; }
    } else {
      current.push(raw);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

const BOX_CHARS = /[│|┃┆┊╎╏┤├┼─━┄┈┄┉║╓╔╗╚╝╠╣╦╩╬┌┐└┘┬┴]/;

function classifyBlock(blockLines, wrapWidth) {
  const lines = Array.isArray(blockLines) ? blockLines : [];
  if (lines.length < 2) return 'prose';

  for (const line of lines) {
    if (/\t/.test(line) || BOX_CHARS.test(line)) return 'verse';
    const runs = (line.match(/ {2,}/g) || []).length;
    if (runs >= 2) return 'verse';
  }

  const indents = new Set();
  for (const line of lines) {
    const m = line.match(/^[ \t　]+/);
    if (m) indents.add(displayWidth(m[0]));
  }
  if (indents.size >= 2) return 'verse';

  const shortThreshold = wrapWidth === Infinity ? 28 : wrapWidth * 0.6;
  const shortCount = lines.filter(l => displayWidth(String(l).trim()) < shortThreshold).length;
  if (shortCount / lines.length >= 0.6) return 'verse';

  return 'prose';
}

function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const line = String(raw);
    if (!out) { out = line; continue; }
    const prev = out[out.length - 1];
    const next = line[0] || '';
    if (prev === '-' && /[A-Za-z]$/.test(out.slice(0, -1)) && /[A-Za-z]/.test(next)) {
      out = out.slice(0, -1) + line;
    } else if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
      out = out + ' ' + line;
    } else {
      out = out + line;
    }
  }
  return out;
}

function reflowProseBlock(blockLines, wrapWidth) {
  const threshold = wrapWidth === Infinity ? Infinity : wrapWidth * 0.75;
  const paragraphs = [];
  let current = [];
  const flush = () => { if (current.length) { paragraphs.push(joinLines(current)); current = []; } };

  for (const raw of (Array.isArray(blockLines) ? blockLines : [])) {
    const startsNewParagraph = /^(　|\t| {2,})/.test(raw);
    const line = String(raw).trim();
    if (!line) continue;
    if (startsNewParagraph) flush();
    current.push(line);
    if (displayWidth(line) < threshold) flush();
  }
  flush();
  return paragraphs;
}

function renderTxtChapterHtml(chapterText, opts = {}) {
  const text = String(chapterText || '').replace(/\r\n?/g, '\n');
  let lines = text.split('\n');
  const title = String((opts && opts.title) || '').trim();

  let titleHtml = '';
  if (title) {
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i < lines.length && lines[i].trim() === title) {
      titleHtml = `<h2 class="txt-chapter-title">${escapeHtml(title)}</h2>`;
      lines = lines.slice(0, i).concat(lines.slice(i + 1));
    }
  }

  const wrapWidth = estimateWrapWidth(lines.filter(l => l.trim() !== ''));
  const parts = [];
  for (const block of segmentBlocks(lines)) {
    if (classifyBlock(block, wrapWidth) === 'verse') {
      parts.push(`<p class="txt-verse">${escapeHtml(block.join('\n'))}</p>`);
    } else {
      for (const para of reflowProseBlock(block, wrapWidth)) {
        if (para) parts.push(`<p>${escapeHtml(para)}</p>`);
      }
    }
  }
  return titleHtml + parts.join('');
}

module.exports = {
  escapeHtml, displayWidth, estimateWrapWidth, segmentBlocks,
  classifyBlock, joinLines, reflowProseBlock, renderTxtChapterHtml,
};
