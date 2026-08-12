import { redactSecrets } from './config.js';

/**
 * Console chokepoint: every dynamic line the harness prints goes through
 * secret redaction, exactly like the NDJSON/summary write chokepoint —
 * provider-derived content (reported model IDs, response IDs, error
 * messages, identity failures) included.
 */

/**
 * The stream failures that mean THE CONSUMER IS GONE.
 *
 * `EPIPE` is the reader closing — a run piped into `head`, a supervisor that
 * exited, a harness that closed the pipe. `ERR_STREAM_DESTROYED` is the same
 * condition reached from this side. Nothing can be done about either and
 * nothing needs to be: the output had nowhere to go, and the run does not
 * depend on it.
 *
 * Everything else is a SURPRISE and is treated as one. An earlier version
 * absorbed every error on both streams, which silently swallowed `EIO`,
 * `ENOSPC` and anything else a future runtime invents — a comment about closed
 * consumers implemented as "ignore all output faults".
 */
const CONSUMER_GONE: ReadonlySet<string> = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

/** Whether a stream error means the far end simply went away. */
export function isConsumerGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CONSUMER_GONE.has(code);
}

/**
 * Keep a broken output stream from ending the process.
 *
 * ── WHY A try/catch AT THE CALL SITE DOES NOT DO THIS ────────────────────────
 * `process.stdout` and `process.stderr` fail once whatever was reading them has
 * gone, and the write does NOT throw where it is issued: the error arrives
 * afterwards as an `'error'` event on the stream, and an `'error'` event with no
 * listener ends the process.
 *
 * That distinction is the whole reason this exists, and it is genuinely
 * deceptive — the EPIPE carries the stack of the write's ORIGIN, so the crash
 * points at the line that logged and reads exactly like a synchronous throw.
 * Measured on Node 22: a serving pool reporting a dropped connection through
 * `printError`, with the stderr consumer closed, exited on an uncaught EPIPE
 * whose top frames were `printError` and the pool's own listener. A `try` around
 * `console.error` catches none of it.
 *
 * ⚠ THE PLATFORMS DIFFER, WHICH IS WHY THIS IS NOT PINNED BY THE PIPE. Node's
 *   stdio pipes are synchronous on Windows and asynchronous on POSIX, so a test
 *   that closes a real pipe discriminates reliably on one and intermittently on
 *   the other — measured 5/5 here and reported ~1/10 on Linux. The case that
 *   proves this guard emits the event directly, which is plain EventEmitter
 *   semantics and identical everywhere.
 *
 * ── WHY AN UNEXPECTED ERROR IS REPORTED RATHER THAN FATAL ────────────────────
 * A surprise is written to the OTHER stream, once, and the run continues. Not
 * fatal, deliberately: the entire point of this guard is that a logging fault
 * must not end a benchmark night, and `ENOSPC` on a redirected stdout would
 * otherwise do exactly that. A failure that actually matters still surfaces
 * through the channel that matters — the artifact writes throw on their own.
 *
 * Once per stream, because the first line is the diagnostic and a repeat under a
 * persistent fault would be two streams reporting each other's failures forever.
 */
export function guardStream(
  name: string,
  stream: { on(event: 'error', listener: (error: unknown) => void): unknown },
  report: (line: string) => void,
): void {
  let reported = false;
  stream.on('error', (error: unknown) => {
    if (isConsumerGone(error)) return;
    if (reported) return;
    reported = true;
    try {
      const code = (error as { code?: unknown } | null)?.code;
      report(
        `[${name}] unexpected output error ${String(code ?? 'with no code')}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // The other stream is gone too. There is nowhere left to say anything,
      // and the run still must not end for want of somewhere to log.
    }
  });
}

/**
 * Installed at import rather than at each entry point, because this module is
 * the chokepoint every dynamic line already passes through — so importing it is
 * what makes the guarantee hold. Module evaluation happens once, so no listener
 * accumulates.
 */
guardStream('stdout', process.stdout, (line) => process.stderr.write(`${redactSecrets(line)}\n`));
guardStream('stderr', process.stderr, (line) => process.stdout.write(`${redactSecrets(line)}\n`));

export function printLine(line: string): void {
  console.log(redactSecrets(line));
}

export function printError(line: string): void {
  console.error(redactSecrets(line));
}
