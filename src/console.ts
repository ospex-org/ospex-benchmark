import { redactSecrets } from './config.js';

/**
 * Console chokepoint: every dynamic line the harness prints goes through
 * secret redaction, exactly like the NDJSON/summary write chokepoint —
 * provider-derived content (reported model IDs, response IDs, error
 * messages, identity failures) included.
 */
/**
 * A closed consumer must not be able to end the process.
 *
 * ── WHY A try/catch AT THE CALL SITE DOES NOT DO THIS ────────────────────────
 * `process.stdout` and `process.stderr` fail with EPIPE once whatever was
 * reading them has gone — a run piped into `head`, a supervisor that exited, a
 * harness that closed the pipe. The write does NOT throw where it is issued:
 * the error is delivered afterwards as an `'error'` event on the stream, and an
 * `'error'` event with no listener ends the process.
 *
 * That distinction is the whole reason this exists, and it is genuinely
 * deceptive: the EPIPE carries the stack of the write's ORIGIN, so the crash
 * report points straight at the line that logged — which reads exactly like a
 * synchronous throw, and made a `try` around `console.error` look sufficient.
 * It catches nothing.
 *
 * Measured on Node 22: a serving pool reporting a dropped connection through
 * `printError`, with the stderr consumer closed, exited on an uncaught EPIPE
 * whose top frames were `printError` and the pool's listener. With these two
 * listeners attached it absorbs the error, prints its next line to the stream
 * that still works, and carries on.
 *
 * ── WHY IT ABSORBS RATHER THAN REPORTS ───────────────────────────────────────
 * The place a report would go IS the thing that broke. There is nothing useful
 * to do and nowhere to do it, and the alternative — dying — loses the run for
 * the sake of a line nobody was going to read.
 *
 * Installed here rather than at each entry point because this module is the
 * chokepoint every dynamic line already passes through, so importing it is what
 * makes the guarantee hold. Module evaluation happens once, so no listener
 * accumulates.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    // Deliberately empty. See above: there is nowhere left to report this.
  });
}

export function printLine(line: string): void {
  console.log(redactSecrets(line));
}

export function printError(line: string): void {
  console.error(redactSecrets(line));
}
