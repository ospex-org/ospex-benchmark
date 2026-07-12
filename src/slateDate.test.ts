import assert from 'node:assert/strict';
import { test } from 'node:test';
import { easternCalendarDay, isValidSlateDate, tomorrowEastern } from './slateDate.js';

test('late-night ET game lands on the NEXT UTC day but the SAME ET slate day', () => {
  // 9:40 pm ET on Jul 11 = 01:40 UTC on Jul 12 (EDT, UTC-4)
  assert.equal(easternCalendarDay('2026-07-12T01:40:00+00:00'), '2026-07-11');
  // 11:59 pm ET Jul 11
  assert.equal(easternCalendarDay('2026-07-12T03:59:00Z'), '2026-07-11');
  // midnight ET rolls the slate day
  assert.equal(easternCalendarDay('2026-07-12T04:00:00Z'), '2026-07-12');
});

test('noon ET game is the same day in both clocks', () => {
  assert.equal(easternCalendarDay('2026-07-12T16:15:00+00:00'), '2026-07-12');
});

test('winter (EST, UTC-5) boundary differs from summer', () => {
  assert.equal(easternCalendarDay('2026-01-15T04:59:00Z'), '2026-01-14');
  assert.equal(easternCalendarDay('2026-01-15T05:00:00Z'), '2026-01-15');
});

test('DST transitions: spring-forward and fall-back days resolve correctly', () => {
  // Spring forward 2026-03-08: 06:59Z = 01:59 EST (Mar 8), 07:01Z = 03:01 EDT (Mar 8)
  assert.equal(easternCalendarDay('2026-03-08T06:59:00Z'), '2026-03-08');
  assert.equal(easternCalendarDay('2026-03-08T07:01:00Z'), '2026-03-08');
  // Fall back 2026-11-01: 05:30Z = 01:30 EDT first pass (Nov 1), 06:30Z = 01:30 EST (Nov 1)
  assert.equal(easternCalendarDay('2026-11-01T05:30:00Z'), '2026-11-01');
  assert.equal(easternCalendarDay('2026-11-01T06:30:00Z'), '2026-11-01');
  // Just before the fall-back day's ET midnight it is still Oct 31
  assert.equal(easternCalendarDay('2026-11-01T03:59:00Z'), '2026-10-31');
});

test('easternCalendarDay both timestamptz wire forms (Z and +00:00)', () => {
  assert.equal(easternCalendarDay('2026-07-12T16:15:00Z'), '2026-07-12');
  assert.equal(easternCalendarDay('2026-07-12T16:15:00+00:00'), '2026-07-12');
});

test('easternCalendarDay rejects garbage', () => {
  assert.throws(() => easternCalendarDay('not-a-date'));
});

test('isValidSlateDate rejects impossible-but-well-formed days', () => {
  assert.equal(isValidSlateDate('2026-02-30'), false);
  assert.equal(isValidSlateDate('2026-04-31'), false);
  assert.equal(isValidSlateDate('2026-13-01'), false);
  assert.equal(isValidSlateDate('2026-00-10'), false);
  assert.equal(isValidSlateDate('07-12-2026'), false);
  assert.equal(isValidSlateDate('2026-7-12'), false);
});

test('isValidSlateDate accepts real days, including leap day', () => {
  assert.equal(isValidSlateDate('2026-07-12'), true);
  assert.equal(isValidSlateDate('2026-02-28'), true);
  assert.equal(isValidSlateDate('2024-02-29'), true);
  assert.equal(isValidSlateDate('2026-02-29'), false);
});

test('tomorrowEastern reasons in ET, not UTC', () => {
  // 23:30 UTC Jul 11 = 19:30 ET Jul 11 → tomorrow is Jul 12
  assert.equal(tomorrowEastern(new Date('2026-07-11T23:30:00Z')), '2026-07-12');
  // 03:30 UTC Jul 12 = 23:30 ET Jul 11 (still Jul 11 in ET!) → tomorrow is Jul 12
  assert.equal(tomorrowEastern(new Date('2026-07-12T03:30:00Z')), '2026-07-12');
  // 05:00 UTC Jul 12 = 01:00 ET Jul 12 → tomorrow is Jul 13
  assert.equal(tomorrowEastern(new Date('2026-07-12T05:00:00Z')), '2026-07-13');
  // month rollover
  assert.equal(tomorrowEastern(new Date('2026-07-31T20:00:00Z')), '2026-08-01');
});
