import type { SearchAudit, SearchAuditQuery, SearchAuditResult } from '../types.js';

/**
 * Per-provider extraction of the web-search AUDIT TRAIL — the executed queries,
 * the result references, and the BILLABLE CALL COUNT — from the verbatim
 * response envelope.
 *
 * Two separations carry the design:
 *
 *  - COUNT vs QUERY TEXT. `searchCount` is the number of billable search calls
 *    and feeds the money guard; the recorded query strings are the audit trail.
 *    The two come from different evidence and fail independently: a provider can
 *    report a reliable count while exposing no query text (xAI publishes no
 *    field-level schema for its `web_search_call` item), and a provider can
 *    expose queries while dropping the metadata that makes the count knowable
 *    (Gemini 3.x previews have been observed omitting `groundingMetadata`).
 *    `searchCount === null` means UNKNOWN and escalates as unpriceable spend;
 *    a missing query never fabricates a count and never silently reads as zero.
 *
 *  - COMPLETE vs INCOMPLETE. Every gap gets a reason in `incomplete[]`. An audit
 *    that says nothing is only ever emitted when the response carries no search
 *    evidence at all (returned as `null`), so "no search ran" and "we could not
 *    see what ran" are never the same value.
 */

/** Stable, greppable reasons an audit is partial. Persisted into evidence. */
export const AUDIT_REASON = Object.freeze({
  /** The provider reported N billable calls but exposed fewer query strings. */
  QUERY_TEXT_MISSING: 'query text unavailable for one or more executed searches',
  /** A search-call item carried no readable query (shape unknown or absent). */
  CALL_WITHOUT_QUERY: 'search call item carried no readable query text',
  /** Executed-search evidence exists but the count cannot be derived. */
  COUNT_UNKNOWN: 'billable search count is not derivable from this response',
  /** The provider returned a tool error instead of results. */
  TOOL_ERROR: 'web search tool returned an error',
  /** The provider cut its server-side tool loop short (e.g. TOO_MANY_TOOL_CALLS). */
  TOOL_LOOP_TRUNCATED: 'the provider terminated the tool loop before it finished',
  /** Grounding evidence proves a search ran, but the metadata is absent. */
  GROUNDING_METADATA_MISSING: 'grounding metadata missing while tool-use tokens prove a search ran',
  /** Sources are present without the queries that produced them. */
  GROUNDING_QUERIES_MISSING: 'grounding sources present without the executed queries',
} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(obj: Record<string, unknown> | undefined, field: string): unknown {
  return obj !== undefined && Object.hasOwn(obj, field) ? obj[field] : undefined;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pushQuery(queries: SearchAuditQuery[], value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  queries.push({ query: value });
  return true;
}

function pushResult(results: SearchAuditResult[], url: unknown, title: unknown): void {
  if (typeof url !== 'string' || url.length === 0) return;
  const entry: SearchAuditResult = {
    url,
    title: typeof title === 'string' && title.length > 0 ? title : null,
  };
  if (!results.some((r) => r.url === entry.url && r.title === entry.title)) results.push(entry);
}

/**
 * Assemble the audit, adding the count/query-consistency reason. `null` only
 * when the response carries no search evidence whatsoever.
 */
function audit(
  queries: SearchAuditQuery[],
  results: SearchAuditResult[],
  searchCount: number | null,
  incomplete: string[],
): SearchAudit | null {
  if (
    queries.length === 0 &&
    results.length === 0 &&
    searchCount === null &&
    incomplete.length === 0
  ) {
    return null;
  }
  // A count that outruns the recorded queries is the "false complete" shape:
  // the response proves searches ran that this audit cannot name.
  if (searchCount !== null && searchCount > queries.length) {
    if (!incomplete.includes(AUDIT_REASON.QUERY_TEXT_MISSING)) {
      incomplete.push(AUDIT_REASON.QUERY_TEXT_MISSING);
    }
  }
  if (searchCount === null && !incomplete.includes(AUDIT_REASON.COUNT_UNKNOWN)) {
    incomplete.push(AUDIT_REASON.COUNT_UNKNOWN);
  }
  return { queries, results, searchCount, incomplete };
}

/**
 * Anthropic Messages API. One `server_tool_use` block (name `web_search`) per
 * executed search carries the query at `input.query` (single string — there is
 * no queries array on this API); the paired `web_search_tool_result` block
 * holds a LIST of `web_search_result` entries on success or a single error
 * OBJECT on failure; later text blocks carry citations.
 *
 * The billable count is the provider's own `usage.server_tool_use.
 * web_search_requests` — the documented billing unit ("each web search counts
 * as one use, regardless of the number of results returned"), not a block
 * tally. Errored searches are documented as not billed while the counter's
 * behaviour for them is not documented, so with an error block present the
 * counter is treated as an upper bound — the conservative direction for money.
 */
export function extractAnthropicSearchAudit(json: unknown): SearchAudit | null {
  const root = isRecord(json) ? json : {};
  const queries: SearchAuditQuery[] = [];
  const results: SearchAuditResult[] = [];
  const incomplete: string[] = [];
  const content = Array.isArray(root['content']) ? root['content'] : [];
  let searchBlocks = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'server_tool_use' && block['name'] === 'web_search') {
      searchBlocks += 1;
      const input = isRecord(block['input']) ? block['input'] : undefined;
      if (!pushQuery(queries, own(input, 'query')) && !incomplete.includes(AUDIT_REASON.CALL_WITHOUT_QUERY)) {
        incomplete.push(AUDIT_REASON.CALL_WITHOUT_QUERY);
      }
    } else if (block['type'] === 'web_search_tool_result') {
      const inner = block['content'];
      if (Array.isArray(inner)) {
        for (const entry of inner) {
          if (isRecord(entry) && entry['type'] === 'web_search_result') {
            pushResult(results, entry['url'], entry['title']);
          }
        }
      } else if (isRecord(inner)) {
        const code = inner['error_code'];
        incomplete.push(
          `${AUDIT_REASON.TOOL_ERROR}${typeof code === 'string' ? `: ${code}` : ''}`,
        );
      }
    } else if (Array.isArray(block['citations'])) {
      for (const citation of block['citations']) {
        if (isRecord(citation) && citation['type'] === 'web_search_result_location') {
          pushResult(results, citation['url'], citation['title']);
        }
      }
    }
  }
  const usage = isRecord(root['usage']) ? root['usage'] : undefined;
  const serverToolUse = isRecord(own(usage, 'server_tool_use'))
    ? (own(usage, 'server_tool_use') as Record<string, unknown>)
    : undefined;
  const reported = count(own(serverToolUse, 'web_search_requests'));
  if (reported === null && searchBlocks === 0 && queries.length === 0 && results.length === 0) {
    // No search evidence at all — the model answered without searching.
    return incomplete.length === 0 ? null : audit(queries, results, null, incomplete);
  }
  // A counter is the billing authority. Without one, blocks prove searches ran
  // but the count stays UNKNOWN rather than being assumed from a block tally
  // the docs do not tie to billing.
  return audit(queries, results, reported, incomplete);
}

/**
 * Google `generateContent` grounding. Executed queries are at
 * `candidates[0].groundingMetadata.webSearchQueries[]` — which is also the only
 * in-response count, since Gemini 3 bills per executed query and reports no
 * counter. Sources are `groundingChunks[].web.{uri,title}` (vertexaisearch
 * redirect URIs).
 *
 * Two observed failure shapes are recorded rather than smoothed over: the
 * grounding metadata missing entirely while `usageMetadata.
 * toolUsePromptTokenCount > 0` proves a search ran, and grounding chunks
 * present without the queries that produced them. Both leave the count UNKNOWN.
 */
export function extractGoogleSearchAudit(json: unknown): SearchAudit | null {
  const root = isRecord(json) ? json : {};
  const queries: SearchAuditQuery[] = [];
  const results: SearchAuditResult[] = [];
  const incomplete: string[] = [];
  const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
  const first = isRecord(candidates[0]) ? candidates[0] : {};
  const grounding = isRecord(first['groundingMetadata']) ? first['groundingMetadata'] : null;
  let queriesReported = false;
  if (grounding !== null) {
    const webSearchQueries = grounding['webSearchQueries'];
    if (Array.isArray(webSearchQueries)) {
      queriesReported = true;
      for (const query of webSearchQueries) pushQuery(queries, query);
    }
    const chunks = grounding['groundingChunks'];
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        const web = isRecord(chunk) && isRecord(chunk['web']) ? chunk['web'] : null;
        if (web !== null) pushResult(results, web['uri'], web['title']);
      }
    }
  }
  const usageMetadata = isRecord(root['usageMetadata']) ? root['usageMetadata'] : undefined;
  const toolUseTokens = count(own(usageMetadata, 'toolUsePromptTokenCount')) ?? 0;
  const searchRan = toolUseTokens > 0;
  if (searchRan && grounding === null) incomplete.push(AUDIT_REASON.GROUNDING_METADATA_MISSING);
  if (!queriesReported && (results.length > 0 || searchRan)) {
    incomplete.push(AUDIT_REASON.GROUNDING_QUERIES_MISSING);
  }
  // A terminated tool loop means the audit cannot claim completeness: queries
  // may have been cut off mid-flight, so the gap is recorded on the audit
  // itself (the adapter separately types the whole turn as unfinished).
  if (first['finishReason'] === 'TOO_MANY_TOOL_CALLS') {
    incomplete.push(AUDIT_REASON.TOOL_LOOP_TRUNCATED);
  }
  // The executed-query list IS the billing unit here; without it the count is
  // unknown even when other evidence proves a search ran.
  const searchCount = queriesReported ? queries.length : null;
  if (
    !queriesReported &&
    !searchRan &&
    results.length === 0 &&
    grounding === null &&
    incomplete.length === 0
  ) {
    return null;
  }
  return audit(queries, results, searchCount, incomplete);
}

/**
 * Responses-API providers (OpenAI and xAI).
 *
 * OpenAI publishes the item schema: a `web_search_call` output item whose
 * search action carries `action.queries[]` (current) or `action.query`
 * (deprecated, still emitted by older doc examples), both optional — the guide
 * says the query text is "usually (but not always)" included, and the
 * reference's own example shows a completed item with no `action` at all.
 * Non-search actions (`open_page`, `find_in_page`) carry no query and no
 * documented fee. The billable count is the number of search-action items; an
 * item whose action is unreadable counts too (over-estimating the fee is the
 * safe direction) and is flagged.
 *
 * xAI publishes NO field-level schema for its `web_search_call` item, so the
 * same defensive parse applies and typically yields no query text — which is
 * recorded, never smoothed. Its count comes from the documented billing
 * counter `usage.server_side_tool_usage_details.web_search_calls`, which
 * overrides the item tally when present (only successful executions bill).
 * Consulted sources arrive by default in the top-level `citations` array; xAI
 * documents no `include` value for them, so none is requested.
 */
export function extractResponsesSearchAudit(json: unknown): SearchAudit | null {
  const root = isRecord(json) ? json : {};
  const queries: SearchAuditQuery[] = [];
  const results: SearchAuditResult[] = [];
  const incomplete: string[] = [];
  const output = Array.isArray(root['output']) ? root['output'] : [];
  let searchCalls = 0;
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item['type'] === 'web_search_call') {
      // A failed tool invocation is a recorded gap, never smoothed over: the
      // audit cannot claim completeness over a call the provider says failed.
      if (item['status'] === 'failed' && !incomplete.includes(AUDIT_REASON.TOOL_ERROR)) {
        incomplete.push(AUDIT_REASON.TOOL_ERROR);
      }
      const action = isRecord(item['action']) ? item['action'] : undefined;
      const actionType = own(action, 'type');
      // Only `search` actions are documented as billable; page navigation
      // actions are not. An item with an unreadable action is counted as a
      // search — a fee over-estimate rather than a silent omission.
      const isSearch = actionType === 'search' || actionType === undefined;
      if (!isSearch) continue;
      searchCalls += 1;
      const plural = own(action, 'queries');
      let recorded = 0;
      if (Array.isArray(plural)) {
        for (const query of plural) if (pushQuery(queries, query)) recorded += 1;
      }
      if (recorded === 0 && pushQuery(queries, own(action, 'query'))) recorded = 1;
      if (recorded === 0 && !incomplete.includes(AUDIT_REASON.CALL_WITHOUT_QUERY)) {
        incomplete.push(AUDIT_REASON.CALL_WITHOUT_QUERY);
      }
      const sources = own(action, 'sources');
      if (Array.isArray(sources)) {
        for (const source of sources) {
          if (typeof source === 'string') pushResult(results, source, null);
          else if (isRecord(source)) pushResult(results, source['url'], source['title']);
        }
      }
    } else if (item['type'] === 'message') {
      const content = Array.isArray(item['content']) ? item['content'] : [];
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'output_text') continue;
        const annotations = Array.isArray(block['annotations']) ? block['annotations'] : [];
        for (const annotation of annotations) {
          if (isRecord(annotation) && annotation['type'] === 'url_citation') {
            pushResult(results, annotation['url'], annotation['title']);
          }
        }
      }
    }
  }
  const citations = root['citations'];
  if (Array.isArray(citations)) for (const url of citations) pushResult(results, url, null);

  const usage = isRecord(root['usage']) ? root['usage'] : undefined;
  const toolUsage = isRecord(own(usage, 'server_side_tool_usage_details'))
    ? (own(usage, 'server_side_tool_usage_details') as Record<string, unknown>)
    : undefined;
  const reported = count(own(toolUsage, 'web_search_calls'));
  // The provider's own billing counter wins when present; otherwise the
  // enumerated search-action items are the count.
  const searchCount = reported ?? (searchCalls > 0 || output.length > 0 ? searchCalls : null);
  if (searchCount === 0 && queries.length === 0 && results.length === 0 && incomplete.length === 0) {
    return null;
  }
  return audit(queries, results, searchCount, incomplete);
}

/** Apply a string redactor to every string the audit carries. */
export function redactSearchAudit(
  auditRecord: SearchAudit | null,
  redact: (text: string) => string,
): SearchAudit | null {
  if (auditRecord === null) return null;
  return {
    queries: auditRecord.queries.map((q) => ({ query: redact(q.query) })),
    results: auditRecord.results.map((r) => ({
      url: redact(r.url),
      title: r.title === null ? null : redact(r.title),
    })),
    searchCount: auditRecord.searchCount,
    incomplete: auditRecord.incomplete.map((reason) => redact(reason)),
  };
}
