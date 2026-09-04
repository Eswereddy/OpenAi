// ai-cache.js
// A small in-memory TTL cache sitting in front of the two paid AI calls
// (ai-summary.js, chat-assistant.js). Purpose: efficiency, not correctness.
//
// During a demo or judging period, the same handful of test profiles and
// the same FAQ questions (especially the chat widget's quick-question
// chips — "What documents do I need?" is asked by nearly every visitor)
// get hit over and over. Without this, each repeat is a fresh paid API
// call and a multi-second round trip. With it, a repeat of the exact same
// input is instant and free.
//
// Deliberately simple: an in-memory Map, not Redis — this is a single-
// process prototype (see server.js's own rate limiter for the same
// reasoning), and a cache that resets on restart is fine here since it's
// purely a speed/cost optimization, never a source of truth. Bounded size
// (oldest-first eviction) so it can never grow unbounded; TTL keeps
// answers from going stale if scheme data changes.

const MAX_ENTRIES = 300;
const store = new Map(); // key -> { value, expiresAt }
const counters = { hits: 0, misses: 0 };

function get(key) {
  const entry = store.get(key);
  if (!entry) {
    counters.misses++;
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    counters.misses++;
    return undefined;
  }
  counters.hits++;
  return entry.value;
}

function set(key, value, ttlMs) {
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value; // Map preserves insertion order
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Exposed via /api/stats so the efficiency gain is visible in the app
// itself, not just in server logs — "how much AI cost/latency this cache
// actually saved" is a real number, not a claim.
function getCacheStats() {
  const total = counters.hits + counters.misses;
  return {
    aiCacheEntries: store.size,
    aiCacheHits: counters.hits,
    aiCacheHitRatePct: total > 0 ? Math.round((counters.hits / total) * 100) : null,
  };
}

module.exports = { get, set, getCacheStats };
