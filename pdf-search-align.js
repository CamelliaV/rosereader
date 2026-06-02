function normalizeChar(ch) {
  if (/\s/.test(ch) || ch === '\u00a0') return ' ';
  return String(ch || '').toLowerCase();
}

function buildNormalizedTextMap(items) {
  const sourceItems = Array.isArray(items) ? items : [];
  const chars = [];
  const map = [];
  let previousWasSpace = true;

  sourceItems.forEach((item, itemIndex) => {
    const text = String(item?.str || '');
    for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
      const normalized = normalizeChar(text[charIndex]);
      if (normalized === ' ') {
        if (previousWasSpace) continue;
        previousWasSpace = true;
      } else {
        previousWasSpace = false;
      }
      chars.push(normalized);
      map.push({ itemIndex, charIndex });
    }

    if (!previousWasSpace && itemIndex < sourceItems.length - 1) {
      chars.push(' ');
      map.push({ itemIndex, charIndex: text.length });
      previousWasSpace = true;
    }
  });

  while (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    map.pop();
  }

  return { text: chars.join(''), map };
}

function normalizeNeedle(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getMatchNeedle(match, query) {
  return normalizeNeedle(match?.matchText || query || '');
}

function getContextNeedles(match) {
  const before = normalizeNeedle(match?.contextBefore || '')
    .replace(/^\.\.\./, '')
    .trim();
  const after = normalizeNeedle(match?.contextAfter || '')
    .replace(/\.\.\.$/, '')
    .trim();
  return {
    before: before.slice(Math.max(0, before.length - 80)),
    after: after.slice(0, 80)
  };
}

function findAllOccurrences(text, needle) {
  const hits = [];
  if (!text || !needle) return hits;
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + Math.max(1, needle.length);
  }
  return hits;
}

function scoreOccurrence(text, start, length, context) {
  let score = 0;
  const beforeText = text.slice(Math.max(0, start - 220), start);
  const afterText = text.slice(start + length, Math.min(text.length, start + length + 220));

  if (context.before) {
    const beforeIdx = beforeText.lastIndexOf(context.before);
    if (beforeIdx !== -1) score += 1000 - Math.min(500, beforeText.length - beforeIdx - context.before.length);
  }
  if (context.after) {
    const afterIdx = afterText.indexOf(context.after);
    if (afterIdx !== -1) score += 1000 - Math.min(500, afterIdx);
  }

  return score;
}

function mapNormalizedRangeToItem(map, start, length) {
  const first = map[start];
  if (!first) return null;
  const endMap = map[Math.max(start, start + length - 1)] || first;
  if (first.itemIndex !== endMap.itemIndex) return null;
  return {
    itemIndex: first.itemIndex,
    charIndex: first.charIndex,
    charLength: Math.max(1, endMap.charIndex - first.charIndex + 1)
  };
}

function findByOccurrence(items, needle, occurrenceInPage) {
  const targetOccurrence = Math.max(0, Math.floor(Number(occurrenceInPage || 0)));
  let occurrence = 0;
  for (let itemIndex = 0; itemIndex < (Array.isArray(items) ? items.length : 0); itemIndex += 1) {
    const raw = String(items[itemIndex]?.str || '');
    const lower = raw.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      if (occurrence === targetOccurrence) {
        return { itemIndex, charIndex: idx, charLength: needle.length };
      }
      occurrence += 1;
      from = idx + Math.max(1, needle.length);
    }
  }
  return null;
}

function findPdfTextLayerMatch(items, match, query) {
  const needle = getMatchNeedle(match, query);
  if (!needle) return null;

  const normalized = buildNormalizedTextMap(items);
  const starts = findAllOccurrences(normalized.text, needle);
  const context = getContextNeedles(match);

  if (starts.length) {
    let best = null;
    for (const start of starts) {
      const mapped = mapNormalizedRangeToItem(normalized.map, start, needle.length);
      if (!mapped) continue;
      const score = scoreOccurrence(normalized.text, start, needle.length, context);
      if (!best || score > best.score) best = { ...mapped, score };
    }
    if (best && best.score > 0) {
      return { itemIndex: best.itemIndex, charIndex: best.charIndex, charLength: best.charLength };
    }
  }

  return findByOccurrence(items, needle, match?.occurrenceInPage);
}

module.exports = {
  buildNormalizedTextMap,
  findPdfTextLayerMatch
};
