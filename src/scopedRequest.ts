import { canonicalize, sha256Hex } from './canonical.js';
import { SMOKE_LABEL } from './types.js';
import type { GameRequest } from './bundle.js';
import type { GameBundle, SlateBundle } from './types.js';

/**
 * The single shared `GameBundle → GameRequest` wrapper (SPEC-line-open-evidence-model.md
 * §3): wrap one frozen `GameBundle` into its dispatchable request — a single-game
 * `SlateBundle` envelope with `cutoffAt` = this game's first pitch — and compute the
 * `requestSha256` the model echoes.
 *
 * Both the batch slate builder (`buildBundle`) and the per-market line-open runtime
 * project a per-game request through THIS one function, so a game's request bytes are
 * identical whichever path built it. That byte-identity is load-bearing: the fire
 * artifact's `requestSha256` / `gameSha256` / `slateSha256` recompute from the retained
 * request preimage, so a second inline copy of this envelope shape would silently drift
 * the hashes (the exact drift the extraction prevents).
 */
export function buildGameRequest(
  game: GameBundle,
  slug: string,
  slateDate: string,
  bundleTimestamp: string,
): GameRequest {
  const requestBundle: SlateBundle = {
    schemaVersion: 1,
    label: SMOKE_LABEL,
    league: 'mlb',
    slateDate,
    bundleTimestamp,
    cutoffAt: game.scheduledStartUtc,
    games: [game],
  };
  return {
    gameId: game.gameId,
    slug,
    game,
    requestBundle,
    requestSha256: sha256Hex(canonicalize(requestBundle)),
  };
}
