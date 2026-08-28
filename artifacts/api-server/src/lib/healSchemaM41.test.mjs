import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  M41_CREATE_INDEX_SQL,
  formatM41IndexMetadata,
  isHealthyM41Index,
  normalizePredicate,
  runM41BestEffort,
} from "../../../../deploy/amvera-all-in-one/heal-schema-m41.mjs";

const migrationSource = readFileSync(
  new URL("../../../../deploy/amvera-all-in-one/heal-schema.mjs", import.meta.url),
  "utf8",
);

const healthyIndex = {
  indisvalid: true,
  indisready: true,
  indislive: true,
  index_method: "btree",
  key_columns: ["user_id", "starts_at", "id"],
  descending: [false, true, true],
  nulls_first: [false, true, false],
  predicate: "(status = 'active'::text)",
  index_definition:
    "CREATE INDEX subscriptions_active_user_starts_at_id_idx ON public.subscriptions USING btree (user_id, starts_at DESC NULLS FIRST, id DESC NULLS LAST) WHERE (status = 'active'::text)",
};

describe("Amvera M-41 schema repair", () => {
  it("uses explicit NULLS LAST for the non-null id tiebreaker", () => {
    expect(M41_CREATE_INDEX_SQL).toContain("id DESC NULLS LAST");
  });

  it("accepts the metadata returned for the intended partial index", () => {
    expect(isHealthyM41Index(healthyIndex)).toBe(true);
    expect(normalizePredicate(" ( status = 'active'::text ) ")).toBe("status='active'::text");
  });

  it("formats only index metadata when production verification fails", () => {
    const formatted = formatM41IndexMetadata(healthyIndex);

    expect(formatted).toContain('"index_method":"btree"');
    expect(formatted).toContain('"index_definition":"CREATE INDEX');
    expect(formatted).not.toContain("users");
    expect(formatM41IndexMetadata(null)).toBe("missing");
  });

  it("rejects the old default-NULLS-FIRST definition that caused the production failure", () => {
    expect(isHealthyM41Index({ ...healthyIndex, nulls_first: [false, true, true] })).toBe(false);
  });

  it("does not propagate a non-critical repair failure to later migrations", async () => {
    const warn = vi.fn();
    const result = await runM41BestEffort(
      async () => {
        throw new Error("index metadata mismatch");
      },
      warn,
    );

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("M-41 skipped"));
  });

  it("reports a successful repair without warning", async () => {
    const warn = vi.fn();
    const result = await runM41BestEffort(async () => undefined, warn);

    expect(result).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the payment guard before the best-effort index repair", () => {
    const m42Position = migrationSource.indexOf("// ── M-42:");
    const m43Position = migrationSource.indexOf("// ── M-43:");
    const m41Position = migrationSource.indexOf("// ── M-41:");

    expect(m42Position).toBeGreaterThan(-1);
    expect(m43Position).toBeGreaterThan(m42Position);
    expect(m41Position).toBeGreaterThan(m43Position);

    const criticalMigrationSection = migrationSource.slice(m43Position, m41Position);
    expect(criticalMigrationSection).toContain("CREATE OR REPLACE FUNCTION payments_subscription_owner_guard()");
    expect(criticalMigrationSection).toContain("CREATE TRIGGER payments_subscription_owner_guard");
    expect(migrationSource.slice(m41Position)).toContain("runM41BestEffort");
  });

  it("casts PostgreSQL name[] metadata to text[] for the Node pg driver", () => {
    expect(migrationSource).toContain("array_agg(a.attname::text ORDER BY key_part.ordinality)");
  });
});