import { beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, vpnKeysTable, vpnNodesTable } from "@workspace/db";

// These URLs are used only by integration-test fixtures. A failed test or an
// interrupted Vitest run can leave one behind in the shared development DB;
// if it stays active, auto-selection tests may choose it and try to provision
// against a nonexistent host.
const TEST_REMOTE_MANAGEMENT_URLS = [
  "http://fake-mgmt.example.com",
  "http://delayed-node.test",
  "http://127.0.0.1:9",
  "https://remote.example.com",
  "https://foreign.example.com",
] as const;

beforeAll(async () => {
  const staleNodes = await db
    .select({ id: vpnNodesTable.id })
    .from(vpnNodesTable)
    .where(inArray(vpnNodesTable.managementApiUrl, [...TEST_REMOTE_MANAGEMENT_URLS]));
  const staleNodeIds = staleNodes.map((node) => node.id);
  if (staleNodeIds.length === 0) return;

  // vpn_keys.node_id is ON DELETE RESTRICT, so remove only fixture-owned keys
  // before removing the fixture nodes. This cleanup never matches a real
  // production Management API URL.
  await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.nodeId, staleNodeIds));
  await db.delete(vpnNodesTable).where(inArray(vpnNodesTable.id, staleNodeIds));
});