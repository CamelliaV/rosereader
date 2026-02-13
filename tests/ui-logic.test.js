/**
 * Unit tests for RoseReader UI logic
 * Run with: node tests/ui-logic.test.js
 */

const assert = require('assert');

// Mock DOM elements and state
let mockState = {};
let mockTimers = [];
let mockClassLists = {};

function resetMocks() {
  mockState = {
    currentBook: null,
    settings: { readerTopBarVisible: true },
    tocHideTimer: null,
    readerUiHideTimer: null
  };
  mockTimers = [];
  mockClassLists = {
    readerView: new Set(),
    tocSidebar: new Set()
  };
}

// Mock setTimeout
function mockSetTimeout(fn, delay) {
  const id = mockTimers.length;
  mockTimers.push({ fn, delay, id, cleared: false });
  return id;
}

function mockClearTimeout(id) {
  if (mockTimers[id]) {
    mockTimers[id].cleared = true;
  }
}

// Simulate the TOC zone detection logic
function getTocZoneX(event, eventType) {
  if (eventType === 'touchstart') {
    return event?.touches?.[0]?.clientX ?? Infinity;
  }
  return event?.clientX ?? Infinity;
}

function shouldShowTocPanel(x) {
  return x <= 120;
}

// Simulate the header zone detection logic
function shouldShowReaderUi(y, headerHeight, settings) {
  if (settings.readerTopBarVisible === false) return false;
  return y <= headerHeight;
}

// Test suite
console.log('Running UI Logic Tests...\n');

// Test 1: TOC zone detection for click events
console.log('Test 1: TOC zone detection for click events');
resetMocks();
{
  // Click at x=50 (in TOC zone)
  const clickInZone = { clientX: 50 };
  const x1 = getTocZoneX(clickInZone, 'click');
  assert.strictEqual(x1, 50, 'Should get clientX from click event');
  assert.strictEqual(shouldShowTocPanel(x1), true, 'Should show TOC panel when x <= 120');

  // Click at x=200 (outside TOC zone)
  const clickOutside = { clientX: 200 };
  const x2 = getTocZoneX(clickOutside, 'click');
  assert.strictEqual(x2, 200, 'Should get clientX from click event');
  assert.strictEqual(shouldShowTocPanel(x2), false, 'Should not show TOC panel when x > 120');

  // Click with no clientX
  const clickNoX = {};
  const x3 = getTocZoneX(clickNoX, 'click');
  assert.strictEqual(x3, Infinity, 'Should default to Infinity when no clientX');
  assert.strictEqual(shouldShowTocPanel(x3), false, 'Should not show TOC panel when x is Infinity');
}
console.log('  PASSED\n');

// Test 2: TOC zone detection for touch events
console.log('Test 2: TOC zone detection for touch events');
resetMocks();
{
  // Touch at x=80 (in TOC zone)
  const touchInZone = { touches: [{ clientX: 80 }] };
  const x1 = getTocZoneX(touchInZone, 'touchstart');
  assert.strictEqual(x1, 80, 'Should get clientX from touch event');
  assert.strictEqual(shouldShowTocPanel(x1), true, 'Should show TOC panel when x <= 120');

  // Touch at x=150 (outside TOC zone)
  const touchOutside = { touches: [{ clientX: 150 }] };
  const x2 = getTocZoneX(touchOutside, 'touchstart');
  assert.strictEqual(x2, 150, 'Should get clientX from touch event');
  assert.strictEqual(shouldShowTocPanel(x2), false, 'Should not show TOC panel when x > 120');

  // Touch with no touches array
  const touchNoTouches = {};
  const x3 = getTocZoneX(touchNoTouches, 'touchstart');
  assert.strictEqual(x3, Infinity, 'Should default to Infinity when no touches');
  assert.strictEqual(shouldShowTocPanel(x3), false, 'Should not show TOC panel when x is Infinity');

  // Touch with empty touches array
  const touchEmptyTouches = { touches: [] };
  const x4 = getTocZoneX(touchEmptyTouches, 'touchstart');
  assert.strictEqual(x4, Infinity, 'Should default to Infinity when touches is empty');
}
console.log('  PASSED\n');

// Test 3: Header zone detection
console.log('Test 3: Header zone detection');
resetMocks();
{
  const headerHeight = 120; // 96 + 24

  // Mouse in header zone
  assert.strictEqual(
    shouldShowReaderUi(50, headerHeight, { readerTopBarVisible: true }),
    true,
    'Should show UI when mouse is in header zone'
  );

  // Mouse outside header zone
  assert.strictEqual(
    shouldShowReaderUi(200, headerHeight, { readerTopBarVisible: true }),
    false,
    'Should not show UI when mouse is outside header zone'
  );

  // Top bar disabled
  assert.strictEqual(
    shouldShowReaderUi(50, headerHeight, { readerTopBarVisible: false }),
    false,
    'Should not show UI when top bar is disabled'
  );
}
console.log('  PASSED\n');

// Test 4: TOC item rendering (variable shadowing fix)
console.log('Test 4: TOC item rendering logic');
{
  // Simulate the fixed renderToc logic
  function renderTocItem(item, index, currentTocActiveIndex) {
    const level = Math.max(0, Math.min(6, Number(item.level || 0)));
    const padding = 18 + level * 14;
    const active = index === currentTocActiveIndex ? ' active' : '';
    const chapterVal = Number(item.chapterIndex);
    const pageVal = Number(item.pageNum);
    const chapterIdx = Number.isFinite(chapterVal) ? ` data-chapter-index="${chapterVal}"` : '';
    const pageNum = Number.isFinite(pageVal) ? ` data-page-num="${pageVal}"` : '';
    const title = item.title || item.href || `Chapter ${index + 1}`;
    return { level, padding, active, chapterIdx, pageNum, title };
  }

  // Test with valid TOC item
  const item1 = { title: 'Introduction', chapterIndex: 0, level: 0 };
  const result1 = renderTocItem(item1, 0, 0);
  assert.strictEqual(result1.title, 'Introduction', 'Should use item title');
  assert.strictEqual(result1.active, ' active', 'Should be active when index matches');
  assert.strictEqual(result1.padding, 18, 'Should have base padding for level 0');

  // Test with nested TOC item
  const item2 = { title: 'Section 1.1', chapterIndex: 1, level: 2 };
  const result2 = renderTocItem(item2, 1, 0);
  assert.strictEqual(result2.padding, 18 + 2 * 14, 'Should have increased padding for level 2');
  assert.strictEqual(result2.active, '', 'Should not be active when index does not match');

  // Test with missing title (fallback)
  const item3 = { chapterIndex: 2 };
  const result3 = renderTocItem(item3, 2, -1);
  assert.strictEqual(result3.title, 'Chapter 3', 'Should fallback to Chapter N+1');

  // Test with href fallback
  const item4 = { href: 'chapter4.html', chapterIndex: 3 };
  const result4 = renderTocItem(item4, 3, -1);
  assert.strictEqual(result4.title, 'chapter4.html', 'Should fallback to href');
}
console.log('  PASSED\n');

// Test 5: Progress scroll restoration logic
console.log('Test 5: Progress scroll restoration logic');
{
  function calculateScrollPosition(progress, scrollHeight, clientHeight) {
    const normalizedProgress = Math.max(0, Math.min(1, progress || 0));
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    return maxScroll * normalizedProgress;
  }

  // Test at 0% progress
  assert.strictEqual(
    calculateScrollPosition(0, 1000, 500),
    0,
    'Should scroll to top at 0% progress'
  );

  // Test at 50% progress
  assert.strictEqual(
    calculateScrollPosition(0.5, 1000, 500),
    250,
    'Should scroll to middle at 50% progress'
  );

  // Test at 100% progress
  assert.strictEqual(
    calculateScrollPosition(1, 1000, 500),
    500,
    'Should scroll to bottom at 100% progress'
  );

  // Test with undefined progress
  assert.strictEqual(
    calculateScrollPosition(undefined, 1000, 500),
    0,
    'Should default to 0 with undefined progress'
  );

  // Test with progress > 1 (should clamp)
  assert.strictEqual(
    calculateScrollPosition(1.5, 1000, 500),
    500,
    'Should clamp progress to 1'
  );

  // Test with negative progress (should clamp)
  assert.strictEqual(
    calculateScrollPosition(-0.5, 1000, 500),
    0,
    'Should clamp progress to 0'
  );
}
console.log('  PASSED\n');

// Test 6: Keydown events should not trigger TOC
console.log('Test 6: Keydown events should not trigger TOC');
{
  function shouldShowTocOnEvent(eventType, x) {
    if (eventType === 'keydown') {
      return false; // Keydown never shows TOC
    }
    return x <= 120;
  }

  assert.strictEqual(
    shouldShowTocOnEvent('keydown', 50),
    false,
    'Keydown should never show TOC even in zone'
  );

  assert.strictEqual(
    shouldShowTocOnEvent('click', 50),
    true,
    'Click in zone should show TOC'
  );

  assert.strictEqual(
    shouldShowTocOnEvent('touchstart', 50),
    true,
    'Touch in zone should show TOC'
  );
}
console.log('  PASSED\n');

// Test 7: Edge case - boundary values for TOC zone
console.log('Test 7: Boundary values for TOC zone');
{
  assert.strictEqual(shouldShowTocPanel(120), true, 'x=120 should be in TOC zone');
  assert.strictEqual(shouldShowTocPanel(121), false, 'x=121 should be outside TOC zone');
  assert.strictEqual(shouldShowTocPanel(0), true, 'x=0 should be in TOC zone');
  assert.strictEqual(shouldShowTocPanel(-1), true, 'x=-1 should be in TOC zone (edge case)');
}
console.log('  PASSED\n');

console.log('All tests passed!');
