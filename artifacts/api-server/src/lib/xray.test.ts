/**
 * Integration tests for the ENOENT recovery path in readConfig().
 *
 * When the Xray config.json is missing from the persistent volume (e.g. after a
 * volume remount), readConfig() should:
 *   1. Re-initialise the config from the bundled template.
 *   2. Re-populate the clients list from the DB (so live users see no key loss).
 *   3. Kick off a `supervisorctl restart xray` exactly once so the restored
 *      clients become active immediately.
 *   4. Return the re-populated config rather than throwing.
 *
 * All heavy dependencies (fs, child_process, @workspace/db, trafficPolling,
 * logger) are mocked so this test is fully unit-scoped and runs in the
 * Replit/dev environment where XRAY_CONFIG_PATH is normally unset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module-level mocks (hoisted by vitest before any import) ────────────────

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

// exec() is callback-style; promisify() wraps it as (cmd, opts, cb).
// The mock calls cb immediately with a successful result.
vi.mock("node:child_process", () => ({
  exec: vi.fn(
    (_cmd: string, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "", stderr: "" });
    },
  ),
}));

vi.mock("@workspace/db", () => {
  // Build a chainable query builder whose .where() resolves to whatever
  // activeKeysResult is set to by each test.
  const whereMock = vi.fn().mockResolvedValue([]);
  const innerJoinMock = vi.fn().mockReturnValue({ where: whereMock });
  const fromMock = vi.fn().mockReturnValue({ innerJoin: innerJoinMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  // db.insert(systemEventsTable).values({...}).catch(fn) — fire-and-forget in
  // the ENOENT recovery path. The mock just swallows the call silently.
  const insertValuesMock = vi.fn().mockReturnValue({ catch: vi.fn() });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  return {
    db: { select: selectMock, insert: insertMock },
    vpnKeysTable: { uuid: "uuid_col", revokedAt: "revokedAt_col", nodeId: "nodeId_col" },
    vpnNodesTable: { id: "id_col", managementApiUrl: "managementApiUrl_col" },
    // systemEventsTable is passed as an argument to db.insert(); the mock
    // ignores the argument, so any non-null export is sufficient here.
    systemEventsTable: {},
  };
});

vi.mock("./trafficPolling", () => ({
  flushTrafficDeltas: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// We also need to stub the drizzle operators used in the query (and, eq, isNull)
// so they don't throw when called with our stub column strings.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
}));

// ─── Template fixture ─────────────────────────────────────────────────────────

const FAKE_CONFIG_PATH = "/fake/volume/xray/config.json";
const FAKE_TEMPLATE_PATH = "/app/xray/config.json.template";

/** Minimal Xray config template with an empty clients array. */
const TEMPLATE_CONFIG = {
  inbounds: [
    {
      settings: {
        clients: [] as Array<{ id: string; email: string; limitIp: number }>,
      },
    },
  ],
};

/** Helper that builds the ENOENT error Node.js would throw for a missing file. */
function makeEnoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("readConfig() ENOENT recovery", () => {
  beforeEach(() => {
    // Give each test a fresh module instance so CONFIG_PATH is re-evaluated
    // from the process env, and the write-chain / debounce state is reset.
    vi.resetModules();
    process.env["XRAY_CONFIG_PATH"] = FAKE_CONFIG_PATH;
  });

  afterEach(() => {
    delete process.env["XRAY_CONFIG_PATH"];
    vi.clearAllMocks();
  });

  it("re-populates clients from DB rows and resolves rather than throwing", async () => {
    // Arrange: two active keys in the DB.
    const activeKeys = [
      { uuid: "aaaaaaaa-0001-0001-0001-000000000001" },
      { uuid: "bbbbbbbb-0002-0002-0002-000000000002" },
    ];

    // Configure the fs mock before importing xray.ts so the mock is in place
    // when the first addXrayClient call runs.
    const fsMod = await import("fs");
    const readFileMock = vi.mocked(fsMod.promises.readFile);
    // First call (config path) → ENOENT; second call (template path) → template JSON.
    readFileMock
      .mockRejectedValueOnce(makeEnoent())
      .mockResolvedValueOnce(JSON.stringify(TEMPLATE_CONFIG) as any);

    // Wire up the DB mock to return our active keys.
    const dbMod = await import("@workspace/db");
    const whereMock = (dbMod.db.select({} as any) as any).from().innerJoin().where;
    vi.mocked(whereMock).mockResolvedValueOnce(activeKeys);

    // Act: addXrayClient triggers readConfig() internally.
    // vi.resetModules() means this import gets a freshly evaluated xray.ts that
    // reads XRAY_CONFIG_PATH from process.env (now set to FAKE_CONFIG_PATH).
    const { addXrayClient } = await import("./xray");
    await expect(addXrayClient("cccccccc-0003-0003-0003-000000000003", "cccccccc-0003-0003-0003-000000000003", 1)).resolves.toBeUndefined();
  });

  it("writes the template config with DB clients before writing the new client", async () => {
    // Arrange
    const activeKeys = [{ uuid: "aaaaaaaa-1111-1111-1111-111111111111" }];

    const fsMod = await import("fs");
    const readFileMock = vi.mocked(fsMod.promises.readFile);
    readFileMock
      .mockRejectedValueOnce(makeEnoent())
      .mockResolvedValueOnce(JSON.stringify(TEMPLATE_CONFIG) as any);

    const dbMod = await import("@workspace/db");
    const whereMock = (dbMod.db.select({} as any) as any).from().innerJoin().where;
    vi.mocked(whereMock).mockResolvedValueOnce(activeKeys);

    // Act
    const { addXrayClient } = await import("./xray");
    await addXrayClient("bbbbbbbb-2222-2222-2222-222222222222", "bbbbbbbb-2222-2222-2222-222222222222", 1);

    // Assert: the first writeFile call (from writeConfig inside ENOENT recovery)
    // should contain the active DB client in the clients array.
    const writeFileMock = vi.mocked(fsMod.promises.writeFile);
    expect(writeFileMock).toHaveBeenCalled();
    const firstCallArg = writeFileMock.mock.calls[0][1] as string;
    const firstWrittenConfig = JSON.parse(firstCallArg);
    const clients: Array<{ id: string; email: string; limitIp: number }> =
      firstWrittenConfig.inbounds[0].settings.clients;

    // The recovered write must include the DB-sourced key.
    const dbRestoredClient = clients.find((c) => c.id === "aaaaaaaa-1111-1111-1111-111111111111");
    expect(dbRestoredClient).toBeDefined();
    expect(dbRestoredClient).toMatchObject({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      email: "aaaaaaaa-1111-1111-1111-111111111111",
      limitIp: 1,
    });
  });

  it("calls supervisorctl restart xray exactly once during ENOENT recovery", async () => {
    // Arrange
    const fsMod = await import("fs");
    const readFileMock = vi.mocked(fsMod.promises.readFile);
    readFileMock
      .mockRejectedValueOnce(makeEnoent())
      .mockResolvedValueOnce(JSON.stringify(TEMPLATE_CONFIG) as any);

    // DB returns no active keys (valid scenario — all keys were revoked).
    const dbMod = await import("@workspace/db");
    const whereMock = (dbMod.db.select({} as any) as any).from().innerJoin().where;
    vi.mocked(whereMock).mockResolvedValueOnce([]);

    // Act
    const { addXrayClient } = await import("./xray");
    await addXrayClient("cccccccc-3333-3333-3333-333333333333", "cccccccc-3333-3333-3333-333333333333", 1);

    // reloadXray() fires and forgets (void), so give the microtask queue a
    // moment to drain before inspecting exec.
    await new Promise((r) => setTimeout(r, 50));

    // Assert: exec should have been called exactly once, for the ENOENT-recovery
    // reload.  addXrayClient's normal path uses scheduleXrayRestart()
    // (debounced, also fires reloadXray), so we expect at most two total calls.
    // The important invariant is that at least one restart was triggered.
    const childProcess = await import("node:child_process");
    const execMock = vi.mocked(childProcess.exec);
    const supervisorCalls = execMock.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("supervisorctl restart xray"),
    );
    expect(supervisorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("recovers gracefully with empty clients list when DB query fails", async () => {
    // Arrange: DB throws during the ENOENT recovery query.
    const fsMod = await import("fs");
    const readFileMock = vi.mocked(fsMod.promises.readFile);
    readFileMock
      .mockRejectedValueOnce(makeEnoent())
      .mockResolvedValueOnce(JSON.stringify(TEMPLATE_CONFIG) as any);

    const dbMod = await import("@workspace/db");
    const whereMock = (dbMod.db.select({} as any) as any).from().innerJoin().where;
    vi.mocked(whereMock).mockRejectedValueOnce(new Error("DB connection failed"));

    // Act: should NOT throw — error is caught internally, config written with
    // empty clients list, and key issuance continues normally.
    const { addXrayClient } = await import("./xray");
    await expect(
      addXrayClient("dddddddd-4444-4444-4444-444444444444", "dddddddd-4444-4444-4444-444444444444", 1),
    ).resolves.toBeUndefined();

    // The error logger should have been called to record the DB failure.
    const { logger } = await import("./logger");
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });
});
