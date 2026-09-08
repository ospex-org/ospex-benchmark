import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TEMPORARY_NETWORK_EXIT = 75;
export const TRANSPORT_FAILURE_LIMIT = 3;
export type InputDependency = 'games' | 'current_odds' | 'history';
type Lane = 'watcher' | 'campaign';
const ALIASES: readonly InputDependency[] = ['games', 'current_odds', 'history'];
const CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH',
  'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const SYSCALLS = new Set(['getaddrinfo', 'connect', 'read', 'recv', 'recvfrom', 'write']);
export interface SafeTransportCause { code: string; syscall?: string }

/** Data descriptors only: never invoke error getters, coercion, stack/message or toJSON.
 * Bounded traversal also handles Node's nested AggregateError connect failures. */
function own(value: unknown, key: string): unknown {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
  } catch { return undefined; }
}
export function transportCause(error: unknown): SafeTransportCause[] | null {
  const queue: unknown[] = [error]; const seen = new Set<unknown>(); const result: SafeTransportCause[] = [];
  for (let n = 0; queue.length > 0 && n < 16; n++) {
    const value = queue.shift();
    if (seen.has(value)) continue;
    seen.add(value);
    // An explicit HTTP response is NOT a transport failure, even with a nested cause.
    if (typeof own(value, 'status') === 'number' || typeof own(value, 'statusCode') === 'number') return null;
    const code = own(value, 'code'); const syscall = own(value, 'syscall');
    if (typeof code === 'string' && CODES.has(code)) {
      result.push({code, ...(typeof syscall === 'string' && SYSCALLS.has(syscall) ? {syscall} : {})});
    }
    const cause = own(value, 'cause'); if (cause !== undefined) queue.push(cause);
    const errors = own(value, 'errors');
    try { if (Array.isArray(errors)) for (let i=0;i<Math.min(errors.length,8);i++) queue.push(own(errors,String(i))); } catch {}
  }
  return result.length === 0 ? null : result;
}

/** Safe wrapper: retains ONLY aliases + allowlisted codes, never the raw Error.cause. */
export class InputTransportFailure extends Error {
  constructor(readonly dependency: InputDependency, readonly codes: readonly SafeTransportCause[]) {
    super(`required input transport failure: ${dependency}`);
    this.name = 'InputTransportFailure';
  }
}

interface Episode { firstFailureAt: string; lastFailureAt: string; failureCount: number }
interface Streak { count: number; firstFailureAt: string; lastFailureAt: string }
interface Observation { success: boolean; failure?: { at: string; codes: readonly SafeTransportCause[] } }
interface GuardOptions {
  lane: Lane;
  emit: (line: string) => void;
  now?: () => number;
  pid?: number;
  bootId?: string;
  /** Watcher health ONLY, outside watch-ledger. Campaign uses its existing tick journal. */
  statePath?: string;
}
function bootId(): string {
  try {const id = readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(); return /^[a-f0-9-]{36}$/.test(id) ? id : 'unknown';}
  catch {return 'unknown';}
}

/** One guard per process. Failure wins over successes of the same alias in the same
 * iteration (several pages, sports, games, or concurrent history reads are NOT polls).
 * A skipped read leaves its streak untouched. No claims, budgets or policy state live here. */
export class InputNetworkGuard {
  private readonly streaks = new Map<InputDependency, Streak>();
  private readonly observations = new Map<InputDependency, Observation>();
  private readonly episodes: Partial<Record<InputDependency, Episode>> = {};
  private activeReads = 0;
  private activeIteration = false;
  private emitted = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly generation: { pid: number; bootId: string };
  lastEvent: string | null = null;
  constructor(private readonly options: GuardOptions) {
    this.now = options.now ?? Date.now;
    this.generation = {pid: options.pid ?? process.pid, bootId: options.bootId ?? bootId()};
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(this.generation.bootId) || !Number.isSafeInteger(this.generation.pid) || this.generation.pid <= 0) {
      throw new Error('invalid input-network process generation');
    }
    if (options.statePath !== undefined && existsSync(options.statePath)) {
      // Corrupt health is a STOP, not a reset-to-healthy. Never interpolate its bytes.
      try {
        const bytes = readFileSync(options.statePath,'utf8');
        if (bytes.length > 4096) throw new Error();
        const state = JSON.parse(bytes) as {version: number; episodes: Record<string, Episode>};
        if (state.version !== 1 || typeof state.episodes !== 'object' || state.episodes === null) throw new Error();
        for (const [alias,e] of Object.entries(state.episodes)) {
          if (!ALIASES.includes(alias as InputDependency) || !Number.isSafeInteger(e.failureCount) || e.failureCount < 1 ||
              !Number.isFinite(Date.parse(e.firstFailureAt)) || !Number.isFinite(Date.parse(e.lastFailureAt))) throw new Error();
          this.episodes[alias as InputDependency] = {failureCount:e.failureCount,
            firstFailureAt:new Date(e.firstFailureAt).toISOString(),lastFailureAt:new Date(e.lastFailureAt).toISOString()};
        }
      } catch {throw new Error('input-network health state unreadable; STOP for operator review');}
    }
  }
  beginIteration(): void {
    if (this.activeIteration || this.activeReads !== 0 || this.stopped) throw new Error('unsafe input-network iteration lifecycle');
    this.observations.clear(); this.activeIteration = true;
  }
  get hasTransportFailure(): boolean {return [...this.observations.values()].some(o => o.failure !== undefined);}
  get restartRequested(): boolean {
    return this.stopped || (this.activeIteration && [...this.observations.entries()].some(([alias,o]) => o.failure !== undefined && (this.streaks.get(alias)?.count ?? 0) >= 2));
  }
  assertAdmissionOpen(): void {
    if (this.restartRequested) {
      const entry = [...this.observations.entries()].find(([,o]) => o.failure !== undefined);
      throw new InputTransportFailure(entry?.[0] ?? 'games', entry?.[1].failure?.codes ?? []);
    }
  }
  async read<T>(alias: InputDependency, read: () => Promise<T>): Promise<T> {
    if (!this.activeIteration) throw new Error('input read outside polling iteration');
    this.assertAdmissionOpen();
    const observation = this.observations.get(alias) ?? {success:false};
    this.observations.set(alias, observation); this.activeReads++;
    try {
      const value = await read(); observation.success = true; return value;
    } catch (error) {
      const codes = error instanceof InputTransportFailure ? error.codes : transportCause(error);
      if (codes !== null) {
        observation.failure = {at:new Date(this.now()).toISOString(), codes};
        throw new InputTransportFailure(alias, codes);
      }
      throw error;
    } finally {this.activeReads--;}
  }
  /** Called only AFTER the iteration and ALL reads/paid work have joined. No process.exit. */
  finishIteration(): number | null {
    if (!this.activeIteration) return null;
    if (this.activeReads !== 0) throw new Error('refusing network exit with input reads in flight');
    this.activeIteration = false;
    let threshold: InputDependency | undefined;
    for (const alias of ALIASES) {
      const observation = this.observations.get(alias);
      if (observation?.failure !== undefined) {
        const at = observation.failure.at; const previous = this.streaks.get(alias);
        const streak = {count:(previous?.count ?? 0)+1, firstFailureAt:previous?.firstFailureAt ?? at, lastFailureAt:at};
        this.streaks.set(alias,streak);
        const old = this.episodes[alias];
        this.episodes[alias] = {failureCount:(old?.failureCount ?? 0)+1,firstFailureAt:old?.firstFailureAt ?? at,lastFailureAt:at};
        if (streak.count >= TRANSPORT_FAILURE_LIMIT) threshold ??= alias;
      } else if (observation?.success === true) {
        this.streaks.delete(alias); delete this.episodes[alias];
      }
    }
    this.persist(); // Durability failure is a STOP, never a recoverable network exit.
    if (threshold === undefined || this.emitted) return null;
    this.stopped = true; this.emitted = true;
    const streak = this.streaks.get(threshold)!; const episode = this.episodes[threshold]!;
    this.lastEvent = JSON.stringify({event:'input_network_restart',lane:this.options.lane,dependency:threshold,
      count:streak.count,firstFailureAt:streak.firstFailureAt,lastFailureAt:streak.lastFailureAt,
      ...this.generation,cause:this.observations.get(threshold)!.failure!.codes,
      episodeFailureCount:episode.failureCount,episodeFirstFailureAt:episode.firstFailureAt,exitCode:TEMPORARY_NETWORK_EXIT});
    this.options.emit(this.lastEvent);
    return TEMPORARY_NETWORK_EXIT;
  }
  private persist(): void {
    const path = this.options.statePath; if (path === undefined || this.observations.size === 0) return;
    const dir = dirname(path); mkdirSync(dir,{recursive:true}); const tmp = `${path}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp,'wx',0o600);
      writeFileSync(fd,JSON.stringify({version:1,episodes:this.episodes})+'\n'); fsyncSync(fd); closeSync(fd); fd=undefined;
      renameSync(tmp,path); const d = openSync(dir,'r'); try {fsyncSync(d);} finally {closeSync(d);}
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {unlinkSync(tmp);} catch {}
    }
  }
}

/** Campaign is one-shot. Poll ONLY its free-input phase, at the pinned cadence, at
 * most three times. Never wrap runTick/claim/dispatch. Its existing durable journal
 * remains begun throughout; an interruption or third failure HALTS, never auto-resumes. */
export async function pollFreeInputs<T>(guard: InputNetworkGuard, pollMs: number, read: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve,ms))): Promise<T> {
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error('invalid input polling cadence');
  for (let attempt=1;;attempt++) {
    guard.beginIteration();
    try {
      const value = await read(); guard.finishIteration(); guard.assertAdmissionOpen(); return value;
    } catch (error) {
      const exit = guard.finishIteration();
      if (!(error instanceof InputTransportFailure) || exit !== null || guard.restartRequested || attempt >= 3) throw error;
      await sleep(pollMs);
    }
  }
}

/** Promise.all is fail-fast and leaks sibling input reads across a safe exit. */
export async function joinInputReads<T>(reads: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(reads);
  // A simultaneous integrity/configuration failure outranks transport recycling.
  const failure = results.find(r => r.status === 'rejected' && !(r.reason instanceof InputTransportFailure)) ??
    results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map(r => (r as PromiseFulfilledResult<T>).value);
}
