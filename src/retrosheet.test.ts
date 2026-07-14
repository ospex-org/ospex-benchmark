import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyOuts,
  GAME_LOG_FIELD_COUNT,
  parseGameLogLine,
  parseRetrosheetDataset,
  RETROSHEET_ATTRIBUTION,
  RetrosheetParseError,
  retrosheetGameRecord,
  retrosheetGameRecordSchema,
  splitCsvLine,
} from './retrosheet.js';
import type { RetrosheetGameRecord, RetrosheetMetaRecord } from './retrosheet.js';

// The VERBATIM first line of the real gl2023.txt (2023 opener, Brewers at
// Cubs, final 0-4 in 51 outs) — the golden parse runs against the shape
// Retrosheet actually publishes, not a synthetic imitation of it.
const REAL_2023_OPENER =
  '"20230330","0","Thu","MIL","NL",1,"CHN","NL",1,0,4,51,"D","","","","CHI11",36054,141,"000000000","00400000x",29,4,0,0,0,0,0,0,0,5,0,12,0,0,2,0,7,4,4,4,0,0,24,12,1,0,1,0,30,6,0,0,0,3,0,0,1,4,0,5,0,0,1,0,7,4,0,0,1,0,27,13,1,2,2,0,"kulpr901","Ron Kulpa","blasc901","Cory Blaser","torrc901","Carlos Torres","viscj901","Jansen Visconti","","(none)","","(none)","counc001","Craig Counsell","rossd001","David Ross","strom001","Marcus Stroman","burnc002","Corbin Burnes","","(none)","swand001","Dansby Swanson","burnc002","Corbin Burnes","strom001","Marcus Stroman","yelic001","Christian Yelich",7,"winkj002","Jesse Winker",10,"adamw002","Willy Adames",6,"tellr001","Rowdy Tellez",3,"contw002","William Contreras",2,"urial001","Luis Urias",5,"mitcg001","Garrett Mitchell",8,"andeb006","Brian Anderson",9,"turab002","Brice Turang",4,"hoern001","Nico Hoerner",4,"swand001","Dansby Swanson",6,"happi001","Ian Happ",7,"bellc002","Cody Bellinger",8,"manct001","Trey Mancini",10,"gomey001","Yan Gomes",2,"hosme001","Eric Hosmer",3,"wisdp001","Patrick Wisdom",5,"mastm001","Miles Mastrobuoni",9,"","Y"';

/** A synthetic, structurally valid game-log line with field overrides. */
function makeLine(overrides: Record<number, string> = {}): string {
  const fields = new Array<string>(GAME_LOG_FIELD_COUNT).fill('');
  fields[0] = '20240615';
  fields[1] = '0';
  fields[2] = 'Sat';
  fields[3] = 'BOS';
  fields[4] = 'AL';
  fields[5] = '70';
  fields[6] = 'NYA';
  fields[7] = 'AL';
  fields[8] = '70';
  fields[9] = '3';
  fields[10] = '5';
  fields[11] = '51';
  fields[12] = 'N';
  for (const [index, value] of Object.entries(overrides)) {
    fields[Number(index)] = value;
  }
  return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(',');
}

// ---------------------------------------------------------------------------
// splitCsvLine
// ---------------------------------------------------------------------------

test('splitCsvLine: mixed quoted and bare fields', () => {
  assert.deepEqual(splitCsvLine('"20230330","0",1,0,4,"D"'), ['20230330', '0', '1', '0', '4', 'D']);
});

test('splitCsvLine: commas inside quoted fields stay in the field', () => {
  assert.deepEqual(splitCsvLine('"a,b",c'), ['a,b', 'c']);
});

test('splitCsvLine: doubled quotes are a literal quote (the real logs contain them)', () => {
  assert.deepEqual(splitCsvLine('"he said ""hi""",x'), ['he said "hi"', 'x']);
});

test('splitCsvLine: empty fields survive', () => {
  assert.deepEqual(splitCsvLine('"",,""'), ['', '', '']);
});

test('splitCsvLine: unterminated quote throws', () => {
  assert.throws(() => splitCsvLine('"open,field'), RetrosheetParseError);
});

// ---------------------------------------------------------------------------
// parseGameLogLine
// ---------------------------------------------------------------------------

test('golden: the verbatim 2023 opener parses to the known result', () => {
  const game = parseGameLogLine(REAL_2023_OPENER, 2023);
  assert.deepEqual(game, {
    date: '2023-03-30',
    season: 2023,
    doubleheaderGame: '0',
    awayTeam: 'MIL',
    homeTeam: 'CHN',
    awayScore: 0,
    homeScore: 4,
    outs: 51,
    completedLater: false,
    forfeit: null,
  });
  assert.equal(classifyOuts(game.outs), 'regulation');
});

test('field-count drift fails loudly', () => {
  const short = REAL_2023_OPENER.split(',').slice(0, 100).join(',');
  assert.throws(() => parseGameLogLine(short, 2023), /format drift/);
});

test('a game dated outside the declared season is refused', () => {
  assert.throws(() => parseGameLogLine(REAL_2023_OPENER, 2024), /outside season 2024/);
});

test('completion info marks the game completed-later', () => {
  const game = parseGameLogLine(makeLine({ 13: '20240616,NYC21,2,2,30' }), 2024);
  assert.equal(game.completedLater, true);
});

test('forfeit codes parse; unknown codes are refused', () => {
  assert.equal(parseGameLogLine(makeLine({ 14: 'V' }), 2024).forfeit, 'V');
  assert.equal(parseGameLogLine(makeLine(), 2024).forfeit, null);
  assert.throws(() => parseGameLogLine(makeLine({ 14: 'X' }), 2024), /unknown forfeit code/);
});

test('malformed scores, outs, and dates are refused', () => {
  assert.throws(() => parseGameLogLine(makeLine({ 9: '-1' }), 2024), RetrosheetParseError);
  assert.throws(() => parseGameLogLine(makeLine({ 10: 'four' }), 2024), RetrosheetParseError);
  assert.throws(() => parseGameLogLine(makeLine({ 11: '0' }), 2024), /implausible/);
  assert.throws(() => parseGameLogLine(makeLine({ 11: '999' }), 2024), /implausible/);
  assert.throws(() => parseGameLogLine(makeLine({ 0: '2024-06-15' }), 2024), /bad date/);
  assert.throws(() => parseGameLogLine(makeLine({ 1: '9' }), 2024), /game-number/);
});

// ---------------------------------------------------------------------------
// classifyOuts — the fit's exclusion/sensitivity boundaries
// ---------------------------------------------------------------------------

test('classifyOuts boundaries: 50 shortened, 51-54 regulation, 55+ extra innings', () => {
  assert.equal(classifyOuts(50), 'shortened');
  assert.equal(classifyOuts(51), 'regulation');
  assert.equal(classifyOuts(54), 'regulation');
  assert.equal(classifyOuts(55), 'extra-innings');
  assert.equal(classifyOuts(75), 'extra-innings');
});

// ---------------------------------------------------------------------------
// dataset contract
// ---------------------------------------------------------------------------

function metaRecord(games: number): RetrosheetMetaRecord {
  return {
    recordType: 'retrosheet_meta',
    seasons: [2023],
    sources: [{ url: 'https://www.retrosheet.org/gamelogs/gl2023.zip', sha256: 'a'.repeat(64) }],
    games,
    attribution: RETROSHEET_ATTRIBUTION,
    generatedAt: '2026-07-14T00:00:00.000Z',
  };
}

function gameRecord(): RetrosheetGameRecord {
  return retrosheetGameRecord(parseGameLogLine(REAL_2023_OPENER, 2023));
}

test('a game parsed from the real line round-trips through the record schema', () => {
  const record = gameRecord();
  assert.deepEqual(retrosheetGameRecordSchema.parse(record), record);
});

test('parseRetrosheetDataset: happy path with count integrity', () => {
  const text = [metaRecord(2), gameRecord(), gameRecord()]
    .map((record) => JSON.stringify(record))
    .join('\n');
  const dataset = parseRetrosheetDataset(text);
  assert.equal(dataset.games.length, 2);
  assert.equal(dataset.meta.attribution, RETROSHEET_ATTRIBUTION);
});

test('parseRetrosheetDataset: meta/record count mismatch is refused', () => {
  const text = [metaRecord(3), gameRecord(), gameRecord()]
    .map((record) => JSON.stringify(record))
    .join('\n');
  assert.throws(() => parseRetrosheetDataset(text), /truncated or edited/);
});

test('parseRetrosheetDataset: a season list disagreeing with the records is refused', () => {
  // meta claims 2023+2024 but every record is 2023 — the seasons field flows
  // into the published artifact, so it must be record-backed.
  const meta = { ...metaRecord(1), seasons: [2023, 2024] };
  const text = [meta, gameRecord()].map((record) => JSON.stringify(record)).join('\n');
  assert.throws(() => parseRetrosheetDataset(text), /seasons/);
});

test('parseRetrosheetDataset: a dataset without the exact attribution notice is invalid', () => {
  const meta = { ...metaRecord(1), attribution: 'data from retrosheet dot org' };
  const text = [meta, gameRecord()].map((record) => JSON.stringify(record)).join('\n');
  assert.throws(() => parseRetrosheetDataset(text), /invalid/i);
});
