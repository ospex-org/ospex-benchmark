import type { MarketOpenRunEvidence } from './marketOpenEvidence.js';
import type { SourcePick } from './scoring.js';
import { instantMs } from './time.js';

export interface MarketOpenScoredTiming {
  version: 'market-open-score-timing-v1';
  market: string;
  eventId: string;
  openerCapturedAt: string;
  observedAt: string;
  openerAgeAtFirstObservationMs: number;
  sendAt: string | null;
  observationToSendLagMs: number | null;
}

/** Labels only. Use the accepted leg's actual send, not claim time or a sibling arm. */
export function marketOpenTimingForPick(evidence: MarketOpenRunEvidence, pick: SourcePick): MarketOpenScoredTiming {
  const p = evidence.prepared.provenance;
  if (pick.gameId !== p.event.gameId || pick.market !== p.event.market) throw new Error('market-open timing pick identity mismatch');
  let sendAt: string | null = null;
  if (pick.kind === 'model') {
    const attempt = evidence.fire.attempts.find((a) => a.slot.armId === pick.participantId && a.slot.role === pick.attemptUsed);
    const recorded = attempt?.evidence as { attempt?: { requestAt?: unknown } } | undefined;
    if (typeof recorded?.attempt?.requestAt !== 'string') throw new Error('market-open accepted leg has no send timestamp');
    sendAt = recorded.attempt.requestAt;
  }
  return {
    version: 'market-open-score-timing-v1', market: p.event.market, eventId: p.event.eventId,
    openerCapturedAt: p.source.openedAt, observedAt: p.observedAt,
    openerAgeAtFirstObservationMs: instantMs(p.observedAt) - instantMs(p.source.openedAt),
    sendAt, observationToSendLagMs: sendAt === null ? null : instantMs(sendAt) - instantMs(p.observedAt),
  };
}
