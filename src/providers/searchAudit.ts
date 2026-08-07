import type { SearchAudit, SearchAuditQuery, SearchAuditResult } from '../types.js';

/**
 * Per-provider extraction of the web-search AUDIT TRAIL — every executed
 * query and every result reference the provider surfaced — from the verbatim
 * response envelope. Extraction is defensive: a shape this parser does not
 * recognize is recorded as an `incomplete` reason, never silently dropped, so
 * a partial audit is visible as partial. Returns `null` only when the
 * response shows NO search activity at all (no blocks, no queries, no
 * citations, no counter) — so pre-search records and search-enabled-but-idle
 * responses are distinguishable from an extraction gap.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushResult(results: SearchAuditResult[], url: unknown, title: unknown): void {
  if (typeof url !== 'string' || url.length === 0) return;
  const entry: SearchAuditResult = {
    url,
    title: typeof title === 'string' && title.length > 0 ? title : null,
  };
  if (!results.some((r) => r.url === entry.url && r.title === entry.title)) results.push(entry);
}

function audit(
  queries: SearchAuditQuery[],
  results: SearchAuditResult[],
  searchCount: number | null,
  incomplete: string[],
): SearchAudit | null {
  if (queries.length === 0 && results.length === 0 && searchCount === null && incomplete.length === 0) {
    return null;
  }
  return { queries, results, searchCount, incomplete };
}

/**
 * Anthropic Messages API: one `server_tool_use` block (name `web_search`) per
 * executed search with the query at `input.query`; a paired
 * `web_search_tool_result` block whose `content` is a LIST of
 * `web_search_result` entries on success, or a single error OBJECT (e.g.
 * `max_uses_exceeded`) on failure; citations ride later text blocks. The
 * usage counter is `usage.server_tool_use.web_search_requests`.
 */
export function extractAnthropicSearchAudit(json: unknown): SearchAudit | null {
  const root = isRecord(json) ? json : {};
  const queries: SearchAuditQuery[] = [];
  const results: SearchAuditResult[] = [];
  const incomplete: string[] = [];
  const content = Array.isArray(root['content']) ? root['content'] : [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'server_tool_use' && block['name'] === 'web_search') {
      const input = isRecord(block['input']) ? block['input'] : {};
      const query = input['query'];
      if (typeof query === 'string' && query.length > 0) queries.push({ query });
      else incomplete.push('server_tool_use block without a readable query');
    } else if (block['type'] === 'web_search_tool_result') {
      const inner = block['content'];
      if (Array.isArray(inner)) {
        for (const entry of inner) {
          if (isRecord(entry) && entry['type'] === 'web_search_result') {
            pushResult(results, entry['url'], entry['title']);
          }
        }
      } else if (isRecord(inner)) {
        // Error shape: a single object with an error_code instead of a list.
        const code = inner['error_code'];
        incomplete.push(
          `web_search_tool_result error${typeof code === 'string' ? `: ${code}` : ''}`,
        );
      }
    } else if (isRecord(block) && Array.isArray(block['citations'])) {
      for (const citation of block['citations']) {
        if (isRecord(citation) && citation['type'] === 'web_search_result_location') {
          pushResult(results, citation['url'], citation['title']);
        }
      }
    }
  }
  const usage = isRecord(root['usage']) ? root['usage'] : {};
  const serverToolUse = isRecord(usage['server_tool_use']) ? usage['server_tool_use'] : {};
  const requests = serverToolUse['web_search_requests'];
  const searchCount =
    typeof requests === 'number' && Number.isSafeInteger(requests) && requests >= 0
      ? requests
      : null;
  return audit(queries, results, searchCount, incomplete);
}

/**
 * Google generateContent: executed queries at
 * `candidates[0].groundingMetadata.webSearchQueries[]`, source references at
 * `groundingMetadata.groundingChunks[].web.{uri,title}` (redirect URIs). The
 * 3.x previews have been observed omitting grounding metadata while
 * `usageMetadata.toolUsePromptTokenCount > 0` proves a search ran — that gap
 * is recorded as an explicit `incomplete` reason.
 */
export function extractGoogleSearchAudit(json: unknown): SearchAudit | null {
  const root = isRecord(json) ? json : {};
  const queries: SearchAuditQuery[] = [];
  const results: SearchAuditResult[] = [];
  const incomplete: string[] = [];
  const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
  const first = isRecord(candidates[0]) ? candidates[0] : {};
  const grounding = isRecord(first['groundingMetadata']) ? first['groundingMetadata'] : null;
  if (grounding !== null) {
    const webSearchQueries = grounding['webSearchQueries'];
    if (Array.isArray(webSearchQueries)) {
      for (const query of webSearchQueries) {
        if (typeof query === 'string' && query.length > 0) queries.push({ query });
      }
    }
    const chunks = grounding['groundingChunks'];
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        const web = isRecord(chunk) && isRecord(chunk['web']) ? chunk['web'] : null;
        if (web !== null) pushResult(results, web['uri'], web['title']);
      }
    } else if (queries.length > 0) {
      incomplete.push('groundingChunks missing while webSearchQueries present');
    }
  }
  const usageMetadata = isRecord(root['usageMetadata']) ? root['usageMetadata'] : {};
  const toolUseTokens = usageMetadata['toolUsePromptTokenCount'];
  const searchRan = typeof toolUseTokens === 'number' && toolUseTokens > 0;
  if (searchRan && grounding === null) {
    incomplete.push('groundingMetadata missing while toolUsePromptTokenCount > 0');
  }
  return audit(queries, results, null, incomplete);
}

/**
 * OpenAI/xAI Responses API: one `web_search_call` output item per executed
 * search — the query at `action.query` (openai documents `action.type ===
 * "search"`; the item is read defensively because xAI's REST field layout for
 * completed calls is not pinned by its docs). Result references come from
 * `action.sources[]` (openai, with the sources include), from `url_citation`
 * annotations on `output_text` content, and from a top-level `citations[]`
 * array (xai). The xai billing counter is
 * `usage.server_side_tool_usage_details.web_search_calls`.
 */
export function extractResponsesSearchAudit(json: unknown): SearchAudit | null {
  const root = isRecord(json) ? json : {};
  const queries: SearchAuditQuery[] = [];
  const results: SearchAuditResult[] = [];
  const incomplete: string[] = [];
  const output = Array.isArray(root['output']) ? root['output'] : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item['type'] === 'web_search_call') {
      const action = isRecord(item['action']) ? item['action'] : {};
      const query = action['query'];
      if (typeof query === 'string' && query.length > 0) {
        // Non-search actions (open_page / find_in_page) carry no query — only
        // items that expose one are recorded as executed queries.
        queries.push({ query });
      } else if (action['type'] === 'search' || !isRecord(item['action'])) {
        incomplete.push('web_search_call item without a readable action.query');
      }
      const sources = action['sources'];
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
  if (Array.isArray(citations)) {
    for (const url of citations) pushResult(results, url, null);
  }
  const usage = isRecord(root['usage']) ? root['usage'] : {};
  const toolUsage = isRecord(usage['server_side_tool_usage_details'])
    ? usage['server_side_tool_usage_details']
    : {};
  const calls = toolUsage['web_search_calls'];
  const searchCount =
    typeof calls === 'number' && Number.isSafeInteger(calls) && calls >= 0 ? calls : null;
  return audit(queries, results, searchCount, incomplete);
}

/** Apply a string redactor to every string the audit carries (queries, urls, titles, reasons). */
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
