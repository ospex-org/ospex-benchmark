import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { installBytesNoClobber, nodeArtifactFs } from './fireArtifactSink.js';
import { instantMs } from './time.js';
import { assertPreparedMarketOpenRun } from './marketOpen.js';
import type { PreparedMarketOpenRun } from './marketOpen.js';
import type { RunEnvelope } from './runner.js';

/** Private persistent local POSIX root only. No shared/network FS or automatic stale-lock recovery. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().min(1).max(4096);
const money = z.number().int().safe().nonnegative();
const instant = text.refine((v) => { try { instantMs(v); return true; } catch { return false; } }, 'invalid instant');
const team = z.object({ name: text, abbreviation: text }).strict();
const game = z.object({ gameId: text, slug: text, sport: text, matchTime: instant, status: text,
  homeTeam: team, awayTeam: team, hasOdds: z.boolean(), contestCreated: z.boolean(),
  contestId: text.nullable(), canCreateContest: z.boolean(),
  externalIds: z.object({ jsonodds: text, sportspage: text.nullable(), rundown: text.nullable() }).strict(),
}).strict();

/** Reject lossy JSON before hashing: undefined, unsafe integral values, accessors, custom prototypes. */
function plainJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('JSON nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (typeof value !== 'object') throw new Error('non-JSON value');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('non-plain JSON object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new Error('symbol JSON member');
  for (const [key, d] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in d) || !d.enumerable) throw new Error('non-data JSON member');
    plainJson(d.value, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('sparse or extended JSON array');
}
const json = z.unknown().refine((v) => { try { plainJson(v); return true; } catch { return false; } }, 'invalid JSON evidence');
const configSchema = z.object({ root: text, cohortId: text, name: text,
  slateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), policySha256: digest,
  admissionPolicySha256: digest, capUsdMicros: money.positive() }).strict();
const slotSchema = z.object({ armId: text, role: z.enum(['initial', 'repair']), ordinal: z.number().int().min(0).max(1) }).strict()
  .refine((s) => s.ordinal === (s.role === 'initial' ? 0 : 1), 'invalid role ordinal');
const preparationSchema = z.object({ name: text, slateDate: text, game,
  market: z.enum(['moneyline', 'spread', 'total']), historyRows: json, observedAt: instant }).strict();
const claimSchema = z.object({ eventId: digest, runId: text, sourceSha256: digest, requestSha256: digest, gameSha256: digest,
  policySha256: digest, reservationUsdMicros: money.positive(), slots: z.array(slotSchema).min(1).max(32),
  preparation: preparationSchema }).strict();
const artifactSchema = z.object({ path: text, sha256: digest }).strict();
const beginSchema = z.object({ eventId: digest, slot: slotSchema, startedAt: instant }).strict();
const finishSchema = z.object({ eventId: digest, slot: slotSchema, finishedAt: instant,
  costUsdMicros: money.nullable(), evidence: json }).strict();
const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), configSha256: digest }).strict(),
  z.object({ type: z.literal('claim'), input: claimSchema }).strict(),
  z.object({ type: z.literal('begin'), input: beginSchema }).strict(),
  z.object({ type: z.literal('finish'), input: finishSchema }).strict(),
  z.object({ type: z.literal('complete'), eventId: digest, artifact: artifactSchema }).strict(),
  z.object({ type: z.literal('terminal'), eventId: digest, status: z.enum(['failed', 'unknown', 'refused']), reason: text }).strict(),
]);
const entrySchema = z.object({ version: z.literal(1), seq: z.number().int().safe().nonnegative(),
  previousSha256: digest.nullable(), operation: operationSchema, sha256: digest }).strict();
export type MarketOpenStoreConfig = z.infer<typeof configSchema>;
export type MarketOpenAttemptSlot = z.infer<typeof slotSchema>;
export type MarketOpenClaimInput = z.infer<typeof claimSchema>;
export type MarketOpenArtifactReference = z.infer<typeof artifactSchema>;
export interface MarketOpenAttempt {
  slot: MarketOpenAttemptSlot; startedAt: string; finishedAt: string | null;
  costUsdMicros: number | null; evidence: unknown;
}
export interface MarketOpenFire {
  claim: MarketOpenClaimInput; admitted: boolean;
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'unknown' | 'refused';
  attempts: MarketOpenAttempt[]; knownCostUsdMicros: number;
  terminalArtifact: MarketOpenArtifactReference | null; reason: string | null;
}
export interface MarketOpenStoreSnapshot {
  reservedUsdMicros: number; knownCostUsdMicros: number; halted: string | null; fires: MarketOpenFire[];
}
export interface MarketOpenCompletionReceipt {
  readonly cohortId: string; readonly eventId: string; readonly runId: string;
  readonly requestSha256: string; readonly artifact: Readonly<MarketOpenArtifactReference>;
}
const receipts = new WeakSet<MarketOpenCompletionReceipt>();
export interface MarketOpenRecordReceipt {
  readonly cohortId: string; readonly eventId: string; readonly runId: string;
  readonly requestSha256: string; readonly sourceSha256: string; readonly gameSha256: string;
  readonly gameId: string; readonly market: string; readonly observedAt: string; readonly reservationUsdMicros: number;
}
const recordReceipts = new WeakMap<MarketOpenRecordReceipt, { store: MarketOpenStore; run: PreparedMarketOpenRun; env: RunEnvelope }>();
export function assertMarketOpenRecordReceipt(receipt: MarketOpenRecordReceipt, run: PreparedMarketOpenRun, env: RunEnvelope): void {
  assertPreparedMarketOpenRun(run);
  const binding = recordReceipts.get(receipt);
  if (!binding || binding.run !== run || binding.env !== env) throw new Error('unbranded or crossed market-open record receipt');
  const fire = binding.store.getFire(receipt.eventId);
  if (!fire || fire.attempts.some((a) => a.finishedAt === null)) throw new Error('record receipt has unfinished attempts');
}
export function assertMarketOpenCompletionReceipt(receipt: MarketOpenCompletionReceipt): void {
  if (!receipts.has(receipt)) throw new Error('unbranded market-open completion receipt');
}
type Operation = z.infer<typeof operationSchema>;
const slotKey = (s: MarketOpenAttemptSlot) => canonicalize(s);
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error('unsafe cumulative spend');
  return sum;
}
function lookup(state: MarketOpenStoreSnapshot, id: string): MarketOpenFire {
  const fire = state.fires.find((f) => f.claim.eventId === id);
  if (!fire) throw new Error('unknown event');
  return fire;
}
function validateClaim(input: MarketOpenClaimInput, config: MarketOpenStoreConfig): void {
  const p = input.preparation;
  if (p.name !== config.name || p.slateDate !== config.slateDate || input.policySha256 !== config.policySha256 ||
      input.eventId !== sha256Hex(canonicalize({ cohortId: config.cohortId, gameId: p.game.gameId, market: p.market })) ||
      input.runId !== `market-open-v1-${input.eventId}`) throw new Error('claim identity conflict');
  const keys = new Set(input.slots.map(slotKey));
  if (keys.size !== input.slots.length) throw new Error('duplicate attempt slot');
  for (const slot of input.slots) {
    if (slot.role === 'repair' && !input.slots.some((s) => s.armId === slot.armId && s.role === 'initial')) {
      throw new Error('repair slot missing initial');
    }
  }
}

/** One semantic reducer is used both before installation and on every replayed transition. */
function reduce(state: MarketOpenStoreSnapshot, op: Operation, config: MarketOpenStoreConfig): void {
  if (op.type === 'init') {
    if (op.configSha256 !== sha256Hex(canonicalize(config))) throw new Error('journal config identity conflict');
    return;
  }
  if (op.type === 'claim') {
    validateClaim(op.input, config);
    if (state.fires.some((f) => f.claim.eventId === op.input.eventId)) throw new Error('duplicate journal claim');
    if (state.fires.length >= 1024) throw new Error('store fire limit');
    const reason = state.halted ?? (op.input.reservationUsdMicros > config.capUsdMicros - state.reservedUsdMicros ? 'cap_exceeded' : null);
    const admitted = reason === null;
    state.fires.push({ claim: op.input, admitted, status: admitted ? 'claimed' : 'refused', attempts: [],
      knownCostUsdMicros: 0, terminalArtifact: null, reason });
    if (admitted) state.reservedUsdMicros = add(state.reservedUsdMicros, op.input.reservationUsdMicros);
    return;
  }
  const fire = lookup(state, 'input' in op ? op.input.eventId : op.eventId);
  if (op.type === 'begin') {
    if (state.halted) throw new Error(`cohort halted: ${state.halted}`);
    if (!fire.admitted || !['claimed', 'running'].includes(fire.status)) throw new Error('fire is terminal');
    const key = slotKey(op.input.slot);
    if (!fire.claim.slots.some((s) => slotKey(s) === key)) throw new Error('undeclared attempt slot');
    if (fire.attempts.some((a) => slotKey(a.slot) === key)) throw new Error('attempt already begun');
    if (instantMs(op.input.startedAt) < instantMs(fire.claim.preparation.observedAt)) throw new Error('attempt predates observation');
    if (op.input.slot.role === 'repair') {
      const initial = fire.attempts.find((a) => a.slot.armId === op.input.slot.armId && a.slot.role === 'initial');
      if (!initial || initial.finishedAt === null || initial.costUsdMicros === null ||
          instantMs(op.input.startedAt) < instantMs(initial.finishedAt)) throw new Error('repair requires settled known initial');
    }
    fire.attempts.push({ slot: op.input.slot, startedAt: op.input.startedAt, finishedAt: null, costUsdMicros: null, evidence: null });
    fire.status = 'running';
  } else if (op.type === 'finish') {
    const attempt = fire.attempts.find((a) => slotKey(a.slot) === slotKey(op.input.slot));
    if (!attempt || attempt.finishedAt !== null || !['running', 'unknown'].includes(fire.status)) throw new Error('attempt is not pending');
    if (instantMs(op.input.finishedAt) < instantMs(attempt.startedAt)) throw new Error('finish predates start');
    attempt.finishedAt = op.input.finishedAt; attempt.costUsdMicros = op.input.costUsdMicros; attempt.evidence = op.input.evidence;
    if (op.input.costUsdMicros === null) {
      fire.status = 'unknown'; fire.reason = 'unknown_attempt_cost'; state.halted ??= fire.reason;
    } else {
      fire.knownCostUsdMicros = add(fire.knownCostUsdMicros, op.input.costUsdMicros);
      state.knownCostUsdMicros = add(state.knownCostUsdMicros, op.input.costUsdMicros);
      if (fire.knownCostUsdMicros > fire.claim.reservationUsdMicros || state.knownCostUsdMicros > config.capUsdMicros) {
        fire.status = 'unknown'; fire.reason = 'spend_breach'; state.halted ??= fire.reason;
      }
    }
  } else if (op.type === 'complete') {
    if (fire.terminalArtifact !== null) throw new Error('terminal artifact already bound');
    if (!['running', 'unknown', 'failed', 'refused'].includes(fire.status)) throw new Error('cannot complete unsent fire');
    if (fire.status === 'running') {
      if (fire.attempts.some((a) => a.finishedAt === null || a.costUsdMicros === null) ||
          fire.claim.slots.filter((s) => s.role === 'initial').some((s) => !fire.attempts.some((a) => slotKey(s) === slotKey(a.slot)))) {
        throw new Error('incomplete attempt evidence');
      }
      fire.status = 'completed';
    }
    // Evidence may attach to a dirty terminal, but never promotes it to clean completion.
    fire.terminalArtifact = op.artifact;
  } else {
    if (!['claimed', 'running'].includes(fire.status)) throw new Error('fire is terminal');
    if (op.status === 'refused' && fire.attempts.length) throw new Error('cannot refuse sent fire');
    const pending = fire.attempts.some((a) => a.finishedAt === null);
    fire.status = pending ? 'unknown' : op.status;
    fire.reason = op.reason;
    if (fire.status === 'unknown') state.halted ??= op.reason;
  }
}

/**
 * Lock ownership survives process death by intentionally remaining on disk. OFFLINE recovery:
 * stop ALL writers, preserve the entire root, remove ONLY .writer-lock, then reopen. Never
 * reset config/journal/reservations. PID liveness is NOT sufficient authority to steal a lock.
 * Disk uncertainty permanently poisons this handle and leaves the lock for that procedure.
 */
export class MarketOpenStore {
  readonly #config: MarketOpenStoreConfig;
  readonly #lock: string;
  readonly #owner: string;
  readonly #lockInode: number;
  #state: MarketOpenStoreSnapshot = { reservedUsdMicros: 0, knownCostUsdMicros: 0, halted: null, fires: [] };
  #seq = 0;
  #previous: string | null = null;
  #bytes = 0;
  #poisoned = false;
  #closed = false;

  constructor(input: MarketOpenStoreConfig) {
    plainJson(input);
    const config = configSchema.parse(input);
    if (process.platform === 'win32') throw new Error('market-open store requires POSIX durability');
    const root = resolve(config.root);
    try { mkdirSync(root, { mode: 0o700 }); nodeArtifactFs.syncDir(dirname(root)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('store root must be a real local directory');
    this.#config = { ...config, root };
    this.#lock = join(root, '.writer-lock');
    try { mkdirSync(this.#lock, { mode: 0o700 }); }
    catch { throw new Error('market-open writer lock occupied; OFFLINE recovery required, never automatically stolen'); }
    this.#lockInode = lstatSync(this.#lock).ino;
    this.#owner = canonicalize({ nonce: randomBytes(32).toString('hex'), pid: process.pid });
    try {
      nodeArtifactFs.syncDir(root);
      this.install(this.#lock, join(this.#lock, 'owner.json'), Buffer.from(this.#owner));
      const configPath = join(root, 'config.json');
      const journal = join(root, 'journal');
      const names = readdirSync(root);
      if (!names.includes('config.json')) {
        if (names.some((n) => n !== '.writer-lock')) throw new Error('incomplete store initialization; OFFLINE recovery required');
        mkdirSync(journal, { mode: 0o700 }); nodeArtifactFs.syncDir(root);
        this.append({ type: 'init', configSha256: sha256Hex(canonicalize(this.#config)) });
        this.install(root, configPath, Buffer.from(canonicalize(this.#config)));
      } else {
        const pinned = this.readCanonical(configPath, configSchema);
        if (canonicalize(pinned) !== canonicalize(this.#config)) throw new Error('store config identity conflict');
        this.replay(journal);
      }
      for (const fire of this.#state.fires) {
        if (fire.status === 'running') this.append({ type: 'terminal', eventId: fire.claim.eventId,
          status: 'unknown', reason: 'recovered_interrupted_run' });
      }
    } catch (e) { this.#poisoned = true; throw e; }
  }

  private install(dir: string, path: string, buffer: Buffer): void {
    installBytesNoClobber(nodeArtifactFs, { dir, finalPath: path, tmpStem: 'market-open', buffer, label: 'market-open state' });
  }
  private readCanonical<T>(path: string, schema: z.ZodType<T>): T {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('invalid journal/config file');
    const bytes = readFileSync(path);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    plainJson(value);
    const result = schema.safeParse(value);
    if (!result.success) throw new Error('invalid journal/config shape', { cause: result.error });
    const parsed = result.data;
    if (!bytes.equals(Buffer.from(canonicalize(parsed)))) throw new Error('noncanonical journal/config bytes');
    return parsed;
  }
  private replay(journal: string): void {
    if (!lstatSync(journal).isDirectory() || realpathSync(journal) !== journal) throw new Error('invalid journal directory');
    const names = readdirSync(journal);
    const files = names.filter((n) => /^\d{10}\.json$/.test(n)).sort();
    if (!files.length || names.some((n) => !/^\d{10}\.json$/.test(n) && !/^\.market-open\.\d+\.[0-9a-f]{16}\.tmp$/.test(n))) {
      throw new Error('invalid journal shape');
    }
    for (const file of files) {
      if (file !== this.filename()) throw new Error('journal sequence gap');
      const path = join(journal, file);
      const entry = this.readCanonical(path, entrySchema);
      const { sha256, ...body } = entry;
      if (entry.seq !== this.#seq || entry.previousSha256 !== this.#previous || sha256 !== sha256Hex(canonicalize(body)) ||
          (entry.seq === 0) !== (entry.operation.type === 'init')) throw new Error('journal hash-chain or genesis violation');
      this.#bytes += lstatSync(path).size;
      if (this.#bytes > MAX_JOURNAL_BYTES || this.#seq >= 100000) throw new Error('journal size limit');
      reduce(this.#state, entry.operation, this.#config);
      if (entry.operation.type === 'complete') this.verifyArtifact(entry.operation.artifact);
      this.#seq++; this.#previous = sha256;
    }
  }
  private filename(): string { return `${String(this.#seq).padStart(10, '0')}.json`; }
  private healthy(): void {
    if (this.#poisoned) throw new Error('market-open store poisoned; OFFLINE recovery required');
    if (this.#closed) throw new Error('market-open store closed');
    try {
      const lock = lstatSync(this.#lock);
      if (!lock.isDirectory() || lock.ino !== this.#lockInode || readFileSync(join(this.#lock, 'owner.json'), 'utf8') !== this.#owner) {
        throw new Error('writer lock ownership changed');
      }
    } catch (e) { this.#poisoned = true; throw e; }
  }
  private append(op: Operation): void {
    this.healthy();
    plainJson(op);
    const operation = operationSchema.parse(op);
    const next = structuredClone(this.#state);
    reduce(next, operation, this.#config);
    const body = { version: 1 as const, seq: this.#seq, previousSha256: this.#previous, operation };
    const sha256 = sha256Hex(canonicalize(body));
    const buffer = Buffer.from(canonicalize({ ...body, sha256 }));
    if (buffer.length > MAX_BYTES || this.#bytes + buffer.length > MAX_JOURNAL_BYTES || this.#seq >= 100000) {
      this.#poisoned = true; throw new Error('journal size limit; store poisoned');
    }
    try {
      const dir = join(this.#config.root, 'journal');
      this.install(dir, join(dir, this.filename()), buffer);
    } catch (e) { this.#poisoned = true; throw e; }
    this.#state = next; this.#previous = sha256; this.#seq++; this.#bytes += buffer.length;
  }
  private verifyArtifact(ref: MarketOpenArtifactReference): void {
    const path = resolve(ref.path);
    if (!isAbsolute(ref.path) || ref.path !== path || !path.startsWith(this.#config.root + sep) || realpathSync(path) !== path) {
      throw new Error('artifact path must be a regular file under store root');
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES || createHash('sha256').update(readFileSync(fd)).digest('hex') !== ref.sha256) {
        throw new Error('terminal artifact SHA or shape mismatch');
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    nodeArtifactFs.syncDir(dirname(path));
  }

  claim(input: MarketOpenClaimInput): { created: boolean; fire: MarketOpenFire } {
    this.healthy(); plainJson(input);
    const parsed = claimSchema.parse(input);
    validateClaim(parsed, this.#config);
    const existing = this.#state.fires.find((f) => f.claim.eventId === parsed.eventId);
    if (existing) {
      if (canonicalize(existing.claim) !== canonicalize(parsed)) throw new Error('claim identity/input conflict');
      return { created: false, fire: structuredClone(existing) };
    }
    this.append({ type: 'claim', input: parsed });
    return { created: true, fire: structuredClone(lookup(this.#state, parsed.eventId)) };
  }
  beginAttempt(input: z.infer<typeof beginSchema>): MarketOpenAttempt {
    this.append({ type: 'begin', input });
    return structuredClone(lookup(this.#state, input.eventId).attempts.at(-1)!);
  }
  finishAttempt(input: z.infer<typeof finishSchema>): MarketOpenFire {
    this.append({ type: 'finish', input });
    return structuredClone(lookup(this.#state, input.eventId));
  }
  complete(eventId: string, artifact: MarketOpenArtifactReference): MarketOpenFire {
    this.healthy(); plainJson(artifact);
    const ref = artifactSchema.parse(artifact);
    const existing = lookup(this.#state, eventId);
    if (existing.terminalArtifact !== null && canonicalize(existing.terminalArtifact) !== canonicalize(ref)) throw new Error('terminal artifact conflict');
    try { this.verifyArtifact(ref); } catch (e) { this.#poisoned = true; throw e; }
    if (existing.terminalArtifact === null) this.append({ type: 'complete', eventId, artifact: ref });
    return structuredClone(lookup(this.#state, eventId));
  }
  fail(eventId: string, reason: string): MarketOpenFire { return this.terminal(eventId, 'failed', reason); }
  refuse(eventId: string, reason: string): MarketOpenFire { return this.terminal(eventId, 'refused', reason); }
  markUnknown(eventId: string, reason: string): MarketOpenFire { return this.terminal(eventId, 'unknown', reason); }
  private terminal(eventId: string, status: 'failed' | 'refused' | 'unknown', reason: string): MarketOpenFire {
    this.append({ type: 'terminal', eventId, status, reason }); return structuredClone(lookup(this.#state, eventId));
  }
  getFire(eventId: string): MarketOpenFire | undefined {
    this.healthy(); return structuredClone(this.#state.fires.find((f) => f.claim.eventId === eventId));
  }
  snapshot(): MarketOpenStoreSnapshot { this.healthy(); return structuredClone(this.#state); }
  /** Record capability precedes artifact creation, but never precedes durable send settlement. */
  recordReceipt(eventId: string, run: PreparedMarketOpenRun, env: RunEnvelope): MarketOpenRecordReceipt {
    this.healthy(); assertPreparedMarketOpenRun(run);
    const fire = lookup(this.#state, eventId); const claim = fire.claim; const p = run.provenance;
    if (fire.attempts.some((a) => a.finishedAt === null)) throw new Error('record receipt has unfinished attempts');
    // Provider settlement is durable before validation stamps acceptedAt.
    // A claimed event alone cannot attest a fabricated/unjournalled live envelope.
    const matched = new Set<string>();
    for (const result of env.results) {
      for (const [role, attempt] of [['initial', result.attempt], ['repair', result.repair]] as const) {
        if (attempt === null) continue;
        const key = { armId: result.arm.participantId, role, ordinal: role === 'initial' ? 0 : 1 } as const;
        const durable = fire.attempts.find((a) => slotKey(a.slot) === slotKey(key));
        if (durable === undefined && attempt.requestAt === null) continue;
        const evidence = durable?.evidence as { attempt?: unknown } | undefined;
        if (durable === undefined || evidence?.attempt === undefined ||
            canonicalize(evidence.attempt) !== canonicalize({ ...attempt, acceptedAt: null })) {
          throw new Error('record receipt attempt does not match durable send evidence');
        }
        matched.add(slotKey(key));
      }
    }
    if (matched.size !== fire.attempts.length) throw new Error('record receipt omitted durable attempts');
    if (p.event.eventId !== eventId || p.event.cohortId !== this.#config.cohortId || p.runId !== claim.runId ||
        p.event.gameId !== claim.preparation.game.gameId || p.event.market !== claim.preparation.market ||
        p.observedAt !== claim.preparation.observedAt || p.source.sha256 !== claim.sourceSha256 ||
        p.requestSha256 !== claim.requestSha256 || p.gameSha256 !== claim.gameSha256 ||
        p.policySha256 !== claim.policySha256 || p.reservationUsdMicros !== claim.reservationUsdMicros) {
      throw new Error('record receipt prepared identity conflict');
    }
    const receipt = Object.freeze({ cohortId: this.#config.cohortId, eventId, runId: claim.runId,
      requestSha256: claim.requestSha256, sourceSha256: claim.sourceSha256, gameSha256: claim.gameSha256,
      gameId: p.event.gameId, market: p.event.market, observedAt: p.observedAt, reservationUsdMicros: claim.reservationUsdMicros });
    recordReceipts.set(receipt, { store: this, run, env }); return receipt;
  }
  completionReceipt(eventId: string): MarketOpenCompletionReceipt {
    this.healthy(); const fire = lookup(this.#state, eventId);
    if (fire.status !== 'completed' || fire.terminalArtifact === null) throw new Error('no clean completion receipt');
    const receipt = Object.freeze({ cohortId: this.#config.cohortId, eventId, runId: fire.claim.runId,
      requestSha256: fire.claim.requestSha256, artifact: Object.freeze({ ...fire.terminalArtifact }) });
    receipts.add(receipt); return receipt;
  }
  close(): void {
    this.healthy();
    try { unlinkSync(join(this.#lock, 'owner.json')); rmdirSync(this.#lock); nodeArtifactFs.syncDir(this.#config.root); }
    catch (e) { this.#poisoned = true; throw e; }
    this.#closed = true;
  }
}
