import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { installBytesNoClobber, nodeArtifactFs } from './fireArtifactSink.js';

const ownerSchema = z.object({
  nonce: z.string().regex(/^[0-9a-f]{64}$/), pid: z.number().int().positive().max(2_147_483_647),
  bootId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  processStartTicks: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
}).strict();
type PreviousOwner = z.infer<typeof ownerSchema>;
export type LocalProcessOwner = Required<PreviousOwner>;
type DeathReason = 'previous-boot' | 'pid-absent' | 'pid-reused' | 'legacy-pid-absent';
export class LocalProcessLockError extends Error {
  constructor(readonly code: 'LOCK_BUSY' | 'LOCK_OWNER_UNKNOWN' | 'LOCK_IO' | 'LOCK_UNSUPPORTED' | 'LOCK_OWNERSHIP_LOST', message: string) {
    super(message); this.name = 'LocalProcessLockError';
  }
}
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
function failureDetail(error: unknown): string {
  // Fixed vocabulary: expose the cause, never arbitrary OS paths/record contents.
  const causes: Record<string, string> = {
    EACCES: 'permission denied', EPERM: 'permission denied', ENOENT: 'required local path is missing',
    EIO: 'disk input/output failure', ENOSPC: 'disk is full', EDQUOT: 'disk quota exceeded',
    EROFS: 'filesystem is read-only', ELOOP: 'symlinked lock evidence is not allowed',
    EMFILE: 'process file-descriptor limit reached', ENFILE: 'system file-descriptor limit reached',
  };
  const code = errno(error);
  return code && causes[code] ? `${causes[code]} (${code})` : 'lock identity or recovery evidence could not be verified';
}
function readRegular(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error('invalid lock record');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function directory(path: string): void {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('not a real directory');
}
/** Field 22 of Linux /proc/PID/stat, kept as decimal ticks (no rounding or clock-age test). */
function processStart(pid: number): string | null {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if (errno(error) !== 'ENOENT' && errno(error) !== 'ESRCH') throw error;
    // hidepid / namespace / permission uncertainty is NOT proof of absence.
    try { process.kill(pid, 0); }
    catch (probe) { if (errno(probe) === 'ESRCH') return null; throw probe; }
    throw new Error('process exists but its start time cannot be read');
  }
  const end = stat.lastIndexOf(')');
  const ticks = stat.slice(end + 2).trim().split(/\s+/)[19];
  if (!stat.startsWith(`${pid} (`) || end < 0 || !ticks || !/^[0-9]+$/.test(ticks)) throw new Error('invalid process stat');
  return ticks;
}
function identity(): LocalProcessOwner {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const processStartTicks = processStart(process.pid);
  return ownerSchema.required().parse({ nonce: randomBytes(32).toString('hex'), pid: process.pid, bootId, processStartTicks });
}
function install(dir: string, path: string, bytes: Buffer): void {
  installBytesNoClobber(nodeArtifactFs, { dir, finalPath: path, tmpStem: 'process-lock', buffer: bytes, label: 'process lock' });
}

/**
 * One local Linux disk / host / PID namespace. Never use age as death evidence.
 * The stable guard's flock belongs to the Node owner's open file description,
 * NOT to a supervisor/helper. Never unlink the guard: that would split exclusion.
 * Directory + nonce + inode fencing is retained for compatibility with old writers.
 */
export class LocalProcessLock {
  readonly #path: string;
  readonly #guard: string;
  readonly #ownerBytes: Buffer;
  readonly #inode: number;
  readonly #device: number;
  readonly #guardInode: number;
  readonly #guardDevice: number;
  #fd: number | undefined;
  constructor(private readonly root: string, private readonly name: '.writer-lock' | '.reader-lock', private readonly label: string) {
    this.#path = join(root, name); this.#guard = join(root, `${name}.guard`);
    let phase = 'reading local process identity';
    let fd: number | undefined;
    try {
      if (process.platform !== 'linux') throw new LocalProcessLockError('LOCK_UNSUPPORTED', `${label}: Linux procfs and util-linux flock are required`);
      if (resolve(root) !== root) throw new Error('root must be absolute');
      directory(root);
      const current = identity();
      this.#ownerBytes = Buffer.from(canonicalize(current));
      phase = 'opening the stable kernel guard';
      fd = openSync(this.#guard, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const guard = fstatSync(fd);
      if (!guard.isFile() || guard.nlink !== 1) throw new Error('guard must be a private regular file');
      this.#guardInode = guard.ino; this.#guardDevice = guard.dev;
      phase = 'acquiring the kernel guard';
      // flock(2) locks the shared open file description. Exiting this short helper
      // does NOT unlock the fd retained here; Node exit/SIGKILL/reboot does.
      const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5_000,
      });
      if (result.status === 1) throw new LocalProcessLockError('LOCK_BUSY', `${label}: another process holds the kernel guard; a live owner or startup is already in progress`);
      if (result.error || result.status !== 0) throw new LocalProcessLockError('LOCK_UNSUPPORTED', `${label}: cannot acquire kernel exclusion; /usr/bin/flock must be available and working`);
      this.#fd = fd; this.checkGuard();
      phase = 'persisting the kernel guard';
      fsyncSync(fd); nodeArtifactFs.syncDir(root);
      let occupied = false;
      try { lstatSync(this.#path); occupied = true; }
      catch (error) { if (errno(error) !== 'ENOENT') throw error; }
      if (occupied) this.recover(current);
      phase = 'creating the owner marker';
      // A legacy writer (which has no kernel guard) still competes on mkdir.
      // If it won, never remove its marker or overwrite its owner record.
      try { mkdirSync(this.#path, { mode: 0o700 }); }
      catch (error) {
        if (errno(error) === 'EEXIST') throw new LocalProcessLockError('LOCK_BUSY', `${label}: another owner created the marker during startup; retry without deleting it`);
        throw error;
      }
      const lock = lstatSync(this.#path); this.#inode = lock.ino; this.#device = lock.dev;
      nodeArtifactFs.syncDir(root);
      install(this.#path, join(this.#path, 'owner.json'), this.#ownerBytes);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      this.#fd = undefined;
      if (error instanceof LocalProcessLockError) throw error;
      const detail = failureDetail(error);
      throw new LocalProcessLockError('LOCK_IO', `${label}: ${phase}: ${detail}; marker preserved, no takeover`);
    }
  }
  private checkGuard(): void {
    const guard = lstatSync(this.#guard);
    if (this.#fd === undefined || !guard.isFile() || guard.nlink !== 1 || guard.ino !== this.#guardInode || guard.dev !== this.#guardDevice) {
      throw new LocalProcessLockError('LOCK_OWNERSHIP_LOST', `${this.label}: kernel guard identity changed; stop this owner`);
    }
  }
  private recover(current: LocalProcessOwner): void {
    let phase = 'reading the previous owner';
    try {
      directory(this.#path);
      const stat = lstatSync(this.#path);
      let bytes: Buffer;
      try { bytes = readRegular(join(this.#path, 'owner.json')); }
      catch (error) {
        if (errno(error) === 'ENOENT') throw new LocalProcessLockError('LOCK_OWNER_UNKNOWN', `${this.label}: owner record is missing; cannot prove its owner dead; inspect the marker offline`);
        throw error;
      }
      let previous: PreviousOwner;
      try { previous = ownerSchema.parse(JSON.parse(bytes.toString('utf8'))); }
      catch { throw new LocalProcessLockError('LOCK_OWNER_UNKNOWN', `${this.label}: owner record is invalid; cannot prove its owner dead; inspect the marker offline`); }
      let reason: DeathReason;
      let observedStartTicks: string | null = null;
      if (previous.bootId !== undefined && previous.bootId !== current.bootId) reason = 'previous-boot';
      else {
        phase = 'checking the previous process identity';
        observedStartTicks = processStart(previous.pid);
        if (observedStartTicks === null) reason = previous.bootId === undefined ? 'legacy-pid-absent' : 'pid-absent';
        else if (previous.bootId === current.bootId && previous.processStartTicks !== undefined && previous.processStartTicks !== observedStartTicks) reason = 'pid-reused';
        else if (previous.bootId === undefined || previous.processStartTicks === undefined) {
          throw new LocalProcessLockError('LOCK_OWNER_UNKNOWN', `${this.label}: cannot prove owner PID ${previous.pid} dead: boot ID or process start time is missing and that PID exists; inspect it offline`);
        } else throw new LocalProcessLockError('LOCK_BUSY', `${this.label}: owner process ${previous.pid} is still running on this boot with the same start time`);
      }
      phase = 'persisting the dead-owner recovery record';
      const history = join(this.root, `${this.name}-recoveries`);
      try { mkdirSync(history, { mode: 0o700 }); }
      catch (error) { if (errno(error) !== 'EEXIST') throw error; }
      directory(history); nodeArtifactFs.syncDir(this.root);
      const previousOwnerSha256 = sha256Hex(bytes.toString('utf8'));
      const previousLock = { device: stat.dev, inode: stat.ino };
      const key = sha256Hex(canonicalize({ previousOwnerSha256, previousLock }));
      const recordPath = join(history, `${key}.json`);
      let existing: Buffer | undefined;
      try { existing = readRegular(recordPath); }
      catch (error) { if (errno(error) !== 'ENOENT') throw error; }
      if (existing) {
        // A crash after durable record install but before rename retries the same
        // recovery, preserving the FIRST timestamp rather than one record per tick.
        const record = JSON.parse(existing.toString('utf8'));
        if (record.version !== 'local-process-lock-recovery-v1' || record.previousOwnerSha256 !== previousOwnerSha256 ||
            canonicalize(record.previousLock) !== canonicalize(previousLock) || canonicalize(record.previousOwner) !== canonicalize(previous) ||
            !Number.isFinite(Date.parse(record.recoveredAt)) ||
            !['previous-boot', 'pid-absent', 'pid-reused', 'legacy-pid-absent'].includes(record.reason)) throw new Error('recovery record conflict');
        // Re-sync a previously installed record before removing its authority marker.
        const recordFd = openSync(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(recordFd); } finally { closeSync(recordFd); }
        nodeArtifactFs.syncDir(history);
      } else install(history, recordPath, Buffer.from(canonicalize({
        version: 'local-process-lock-recovery-v1', recoveredAt: new Date().toISOString(), previousOwner: previous,
        previousOwnerSha256, previousLock, reason, recoveredBy: current,
        proof: { currentBootId: current.bootId, observedProcessStartTicks: observedStartTicks },
      })));
      phase = 'archiving the dead-owner marker';
      this.checkGuard();
      const before = lstatSync(this.#path);
      if (before.ino !== stat.ino || before.dev !== stat.dev || !readRegular(join(this.#path, 'owner.json')).equals(bytes)) {
        throw new Error('previous owner changed during recovery');
      }
      // Preserve evidence; never reset or delete config, journals or reservations.
      renameSync(this.#path, join(history, `${key}.lock`));
      nodeArtifactFs.syncDir(history); nodeArtifactFs.syncDir(this.root);
    } catch (error) {
      if (error instanceof LocalProcessLockError) throw error;
      const detail = failureDetail(error);
      throw new LocalProcessLockError('LOCK_IO', `${this.label}: ${phase}: ${detail}; no new owner admitted`);
    }
  }
  assertOwned(): void {
    this.checkGuard();
    const stat = lstatSync(this.#path);
    if (!stat.isDirectory() || stat.ino !== this.#inode || stat.dev !== this.#device ||
        !readRegular(join(this.#path, 'owner.json')).equals(this.#ownerBytes)) {
      throw new LocalProcessLockError('LOCK_OWNERSHIP_LOST', `${this.label}: writer lock ownership changed; stop this owner`);
    }
  }
  release(): void {
    this.assertOwned();
    unlinkSync(join(this.#path, 'owner.json')); rmdirSync(this.#path); nodeArtifactFs.syncDir(this.root);
    this.abandon();
  }
  /** Constructor/replay failure: preserve the marker; release only our kernel fd. */
  abandon(): void { if (this.#fd !== undefined) { closeSync(this.#fd); this.#fd = undefined; } }
}
