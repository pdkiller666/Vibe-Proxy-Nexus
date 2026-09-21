import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, vpnNodesTable } from "@workspace/db";
import { deactivateNodeAtObservedFailureCount } from "./nodeMonitoring";

describe("node monitoring state transitions", () => {
  const nodeIds: number[] = [];

  afterAll(async () => {
    for (const id of nodeIds) {
      await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, id));
    }
  });

  it("does not apply a stale failure decision after a successful poll reset the counter", async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Monitoring CAS ${Date.now()}`,
        region: "test",
        host: "monitoring-cas.example.com",
        sni: "monitoring-cas.example.com",
        isActive: true,
        consecutiveFailures: 3,
      })
      .returning({ id: vpnNodesTable.id });
    nodeIds.push(node.id);

    // Simulate a successful concurrent poll landing after the failing poll
    // observed count=3 but before it attempts deactivation.
    await db
      .update(vpnNodesTable)
      .set({ consecutiveFailures: 0 })
      .where(eq(vpnNodesTable.id, node.id));

    expect(await deactivateNodeAtObservedFailureCount(node.id, 3)).toBe(false);

    const [current] = await db
      .select({
        isActive: vpnNodesTable.isActive,
        consecutiveFailures: vpnNodesTable.consecutiveFailures,
      })
      .from(vpnNodesTable)
      .where(eq(vpnNodesTable.id, node.id));
    expect(current).toEqual({ isActive: true, consecutiveFailures: 0 });
  });
});