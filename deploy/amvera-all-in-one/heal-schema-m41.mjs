export const M41_INDEX_NAME = "subscriptions_active_user_starts_at_id_idx";
export const M41_ADVISORY_LOCK_KEY = 410041;
export const M41_CREATE_INDEX_SQL = `
  CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriptions_active_user_starts_at_id_idx
    ON subscriptions(user_id, starts_at DESC NULLS FIRST, id DESC NULLS LAST)
    WHERE status = 'active'
`;

export function normalizePredicate(predicate) {
  return String(predicate ?? "")
    .toLowerCase()
    .replace(/[\s()]/g, "");
}

export function formatM41IndexMetadata(index) {
  if (!index) {
    return "missing";
  }

  return JSON.stringify({
    indisvalid: index.indisvalid,
    indisready: index.indisready,
    indislive: index.indislive,
    index_method: index.index_method,
    key_columns: index.key_columns,
    descending: index.descending,
    nulls_first: index.nulls_first,
    predicate: index.predicate,
    index_definition: index.index_definition,
  });
}

export function isHealthyM41Index(index) {
  return Boolean(
    index?.indisvalid &&
      index.indisready &&
      index.indislive &&
      index.index_method === "btree" &&
      Array.isArray(index.key_columns) &&
      index.key_columns.join(",") === "user_id,starts_at,id" &&
      Array.isArray(index.descending) &&
      index.descending.join(",") === "false,true,true" &&
      Array.isArray(index.nulls_first) &&
      index.nulls_first.join(",") === "false,true,false" &&
      normalizePredicate(index.predicate) === "status='active'::text",
  );
}

export async function runM41BestEffort(ensureIndex, warn = console.warn) {
  try {
    await ensureIndex();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`heal-schema: M-41 skipped; non-critical index repair will retry on the next startup: ${message}`);
    return false;
  }
}