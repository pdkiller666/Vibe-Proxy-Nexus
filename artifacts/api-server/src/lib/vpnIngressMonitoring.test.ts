import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  nodes: [] as Array<Record<string, any>>,
  events: [] as Array<Record<string, any>>,
  keys: [] as Array<Record<string, any>>,
  probe: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  remoteAdd: vi.fn(),
  remoteRemove: vi.fn(),
}));

vi.mock("./vpnIngressProbe", () => ({
  probeVpnWsIngress: testState.probe,
}));

vi.mock("./remoteNode", () => ({
  addRemoteXrayClient: testState.remoteAdd,
  removeRemoteXrayClient: testState.remoteRemove,
}));

vi.mock("./logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  desc: (column: unknown) => ({ op: "desc", column }),
  eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: "inArray", column, values }),
  isNull: (column: unknown) => ({ op: "isNull", column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
}));

vi.mock("@workspace/db", () => {
  const column = (table: string, name: string) => ({ table, name });
  const vpnNodesTable = {
    id: column("vpn_nodes", "id"),
    name: column("vpn_nodes", "name"),
    host: column("vpn_nodes", "host"),
    sni: column("vpn_nodes", "sni"),
    port: column("vpn_nodes", "port"),
    isActive: column("vpn_nodes", "is_active"),
    transport: column("vpn_nodes", "transport"),
  };
  const systemEventsTable = {
    id: column("system_events", "id"),
    eventType: column("system_events", "eventType"),
    metadata: column("system_events", "metadata"),
    userId: column("system_events", "user_id"),
    createdAt: column("system_events", "created_at"),
  };

  const flatten = (value: unknown): Array<Record<string, any>> =>
    Array.isArray(value)
      ? value.flatMap((part) => flatten(part))
      : value && typeof value === "object"
        ? [value as Record<string, any>]
        : [];

  const queryRows = (
    source: unknown,
    conditions: unknown,
    selection: Record<string, { name: string }>,
  ) => {
    const predicates = flatten(conditions);
    if (source === vpnNodesTable) {
      return testState.nodes
        .filter((node) => node.isActive === true && node.transport === "ws")
        .map((node) => Object.fromEntries(
          Object.entries(selection).map(([key, selectedColumn]) => [key, node[selectedColumn.name]]),
        ));
    }

    if (source === systemEventsTable) {
      const eventTypeFilter = predicates.find((predicate) => predicate.op === "inArray");
      const nodeFilter = predicates.find((predicate) => predicate.op === "sql");
      const nodeIdText = nodeFilter?.values?.find((value: unknown) => typeof value === "string");
      const nodeId = typeof nodeIdText === "string"
        ? JSON.parse(nodeIdText).nodeId as number
        : undefined;
      return testState.events
        .filter((event) =>
          (!eventTypeFilter || eventTypeFilter.values.includes(event.eventType)) &&
          (nodeId === undefined || event.metadata?.nodeId === nodeId) &&
          event.userId == null
        )
        .sort((left, right) => right.id - left.id)
        .map((event) => Object.fromEntries(
          Object.entries(selection).map(([key, selectedColumn]) => [key, event[selectedColumn.name]]),
        ));
    }

    return [];
  };

  const jobsDb = {
    select: vi.fn((selection: Record<string, { name: string }>) => {
      let source: unknown;
      let conditions: unknown;
      const execute = () => queryRows(source, conditions, selection);
      const query = {
        from(table: unknown) {
          source = table;
          return query;
        },
        where(whereClause: unknown) {
          conditions = whereClause;
          return query;
        },
        orderBy() {
          return query;
        },
        limit(count: number) {
          return Promise.resolve(execute().slice(0, count));
        },
        then(
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(execute()).then(resolve, reject);
        },
      };
      return query;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (event: Record<string, any>) => {
        testState.events.push({
          ...event,
          id: testState.events.length + 1,
          acknowledgedAt: null,
          createdAt: new Date(testState.events.length + 1),
          userId: null,
        });
      }),
    })),
    update: testState.update,
    delete: testState.delete,
  };

  return { jobsDb, systemEventsTable, vpnNodesTable };
});

const nodeFixture = {
  id: 42_001,
  name: "Ingress monitor test node",
  host: "198.51.100.10",
  sni: "ingress-test.example.com",
  port: 443,
  isActive: true,
  transport: "ws",
};

const failedProbe = {
  ok: false,
  stage: "connect",
  elapsedMs: 25,
  statusCode: null,
  error: "connection refused",
} as const;

const successfulProbe = {
  ok: true,
  stage: "ws_upgrade",
  elapsedMs: 18,
  statusCode: 101,
  error: null,
} as const;

describe("VPN ingress monitoring", () => {
  let runCycle: () => Promise<void>;

  beforeEach(async () => {
    testState.nodes = [{ ...nodeFixture }];
    testState.events = [];
    testState.keys = [{ id: 77, nodeId: nodeFixture.id, revokedAt: null }];
    testState.probe.mockReset();
    testState.update.mockClear();
    testState.delete.mockClear();
    testState.remoteAdd.mockClear();
    testState.remoteRemove.mockClear();

    vi.resetModules();
    ({ runVpnIngressMonitoringCycleForTests: runCycle } = await import("./vpnIngressMonitoring"));
  });

  it("creates one outage event only after three consecutive failures", async () => {
    testState.probe
      .mockResolvedValueOnce(failedProbe)
      .mockResolvedValueOnce(successfulProbe)
      .mockResolvedValueOnce(failedProbe)
      .mockResolvedValueOnce(failedProbe)
      .mockResolvedValue(failedProbe);

    await runCycle();
    await runCycle();
    await runCycle();
    await runCycle();
    expect(testState.events).toHaveLength(0);

    await runCycle();
    expect(testState.events).toHaveLength(1);
    expect(testState.events[0]).toMatchObject({
      eventType: "vpn_ingress_unreachable",
      metadata: {
        nodeId: nodeFixture.id,
        consecutiveFailures: 3,
        probeSource: "amvera-api",
      },
    });

    await runCycle();
    expect(testState.events).toHaveLength(1);
  });

  it("records recovery after an API restart and does not repeat it on later healthy cycles", async () => {
    testState.probe.mockResolvedValue(failedProbe);
    await runCycle();
    await runCycle();
    await runCycle();
    expect(testState.events.map((event) => event.eventType)).toEqual(["vpn_ingress_unreachable"]);
    testState.events[0]!.acknowledgedAt = new Date();

    // A fresh module instance represents a process restart: the in-memory
    // state is gone, but the acknowledged outage event remains in the store.
    vi.resetModules();
    ({ runVpnIngressMonitoringCycleForTests: runCycle } = await import("./vpnIngressMonitoring"));
    testState.probe.mockResolvedValue(successfulProbe);

    await runCycle();
    await runCycle();

    expect(testState.events.map((event) => event.eventType)).toEqual([
      "vpn_ingress_unreachable",
      "vpn_ingress_recovered",
    ]);
    expect(testState.events[1]?.metadata).toMatchObject({
      nodeId: nodeFixture.id,
      probeSource: "amvera-api",
    });
  });

  it("does not deactivate the node or alter/migrate its key after ingress failures", async () => {
    testState.probe.mockResolvedValue(failedProbe);

    await runCycle();
    await runCycle();
    await runCycle();

    expect(testState.nodes[0]?.isActive).toBe(true);
    expect(testState.keys).toEqual([{ id: 77, nodeId: nodeFixture.id, revokedAt: null }]);
    expect(testState.update).not.toHaveBeenCalled();
    expect(testState.delete).not.toHaveBeenCalled();
    expect(testState.remoteAdd).not.toHaveBeenCalled();
    expect(testState.remoteRemove).not.toHaveBeenCalled();
  });
});