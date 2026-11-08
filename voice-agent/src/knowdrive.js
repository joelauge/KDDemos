import { config } from "./config.js";

/**
 * KnowDrive accepts two kinds of credential: a JWT (e.g. from mint_token or an
 * OAuth login) as a Bearer token, and a stateless PASETO API token in the
 * X-API-TOKEN header. Pick by shape so either can go in KNOWDRIVE_API_TOKEN.
 */
function authHeader(token) {
  return token.startsWith("eyJ") && token.split(".").length === 3
    ? { Authorization: `Bearer ${token}` }
    : { "X-API-TOKEN": token };
}

/**
 * Search the configured KnowDrive store and return the top passages.
 * Uses GET /api/v1/search (hybrid: vector + full-text) with the breadcrumb
 * stripped from each atom's text so the model sees clean passages.
 *
 * @returns {Promise<Array<{text: string, uri: string, score: number}>>}
 */
export async function searchKnowDrive(query, { limit = config.knowdrive.topK } = {}) {
  const { baseUrl, apiToken, vectorStoreId, tagQuery } = config.knowdrive;
  const params = new URLSearchParams({
    vector_store_id: vectorStoreId,
    query,
    mode: "hybrid",
    text: "raw",
    fields: "text,uri,score,metadata",
    // Over-fetch a little so de-duplication still leaves `limit` passages.
    limit: String(Math.min(limit * 2, 50)),
  });
  if (tagQuery) params.set("tag_query", tagQuery);

  const started = Date.now();
  const res = await fetch(`${baseUrl}/api/v1/search?${params}`, {
    headers: { ...authHeader(apiToken), Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KnowDrive search failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  const seen = new Set();
  const passages = [];
  for (const atom of data.atoms || []) {
    // Drop YAML front matter (title/tags/ids): it carries no answer and would
    // otherwise use up a passage slot when an atom is only the file header.
    const text = (atom.text || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    // Skip empty atoms and bare provenance footers ("Where this comes from: …").
    if (!text || /^where this comes from:/i.test(text)) continue;
    const key = text.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    passages.push({
      text,
      uri: atom.uri || atom.metadata?.table_id || "unknown",
      score: atom.score ?? 0,
    });
    if (passages.length >= limit) break;
  }

  console.log(`[knowdrive] "${query}" -> ${passages.length} passages in ${Date.now() - started}ms`);
  return passages;
}
