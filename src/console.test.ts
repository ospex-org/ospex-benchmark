import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { guardStream, isConsumerGone, printError, printLine } from './console.js';

test('captured console output is redacted — a credential in a provider-derived line never prints', () => {
  const secret = 'stub-console-secret-abcdef123456';
  const original = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = secret;
  const originalLog = console.log;
  const originalError = console.error;
  const captured: string[] = [];
  console.log = (message?: unknown) => {
    captured.push(String(message));
  };
  console.error = (message?: unknown) => {
    captured.push(String(message));
  };
  try {
    printLine(`  reported model: ${secret}`);
    printLine(`  response id: ${secret}`);
    printError(`  MODEL_IDENTITY: arm reported unapproved model ID "${secret}"`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (original === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = original;
    }
  }
  assert.equal(captured.length, 3);
  for (const line of captured) {
    assert.ok(!line.includes(secret));
    assert.ok(line.includes('[REDACTED]'));
  }
});

// ---------------------------------------------------------------------------
// The output-stream guard
// ---------------------------------------------------------------------------

test('only a GONE CONSUMER is absorbed silently — every other fault is reported', () => {
  // The first version of this guard was an empty listener on both streams,
  // which read as "absorb a closed pipe" and behaved as "ignore every output
  // fault". A reviewer demonstrated EIO, ENOSPC and ERR_STREAM_DESTROYED going
  // the same way. Two of those are surprises worth a line; one is not.
  assert.equal(isConsumerGone(Object.assign(new Error('x'), { code: 'EPIPE' })), true);
  assert.equal(isConsumerGone(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' })), true);
  for (const code of ['EIO', 'ENOSPC', 'EACCES', undefined]) {
    assert.equal(
      isConsumerGone(code === undefined ? new Error('no code') : Object.assign(new Error('x'), { code })),
      false,
      `${String(code)} is a surprise, not a closed consumer`,
    );
  }
  assert.equal(isConsumerGone(null), false);
  assert.equal(isConsumerGone('EPIPE'), false, 'a bare string is not an error object');
});

test('the guard reports an unexpected fault once, on the other stream, and never throws', () => {
  const reported: string[] = [];
  const stream = new EventEmitter();
  guardStream('stdout', stream, (line) => reported.push(line));

  // A closed consumer: absorbed, and silent. Emitting at all proves the
  // listener is attached — an EventEmitter with none would throw right here.
  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(reported, []);

  // A surprise: reported, and named.
  stream.emit('error', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
  assert.equal(reported.length, 1);
  assert.match(reported[0] ?? '', /\[stdout\] unexpected output error ENOSPC/);
  assert.match(reported[0] ?? '', /no space left on device/);

  // ONCE. Under a persistent fault the two streams would otherwise report each
  // other's failures indefinitely.
  stream.emit('error', Object.assign(new Error('again'), { code: 'ENOSPC' }));
  assert.equal(reported.length, 1, 'the guard must not report the same stream twice');
});

test('a reporter that itself throws does not end the process', () => {
  // Both streams gone. The place a report would go is the thing that broke, so
  // there is nowhere left to say anything — and the run still must not die for
  // want of somewhere to log.
  const stream = new EventEmitter();
  guardStream('stderr', stream, () => { throw new Error('the other stream is gone too'); });
  assert.doesNotThrow(() => {
    stream.emit('error', Object.assign(new Error('x'), { code: 'EIO' }));
  });
});
