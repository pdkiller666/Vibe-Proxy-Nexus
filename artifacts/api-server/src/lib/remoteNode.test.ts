import { afterEach, describe, expect, it, vi } from "vitest";
import { addRemoteXrayClient, listRemoteXrayClients } from "./remoteNode";

const node = {
  name: "Remote test node",
  managementApiUrl: "https://remote.example.com",
  managementApiSecret: "test-secret",
};

describe("listRemoteXrayClients", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects malformed inventory entries instead of returning a partial list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "valid-uuid" }, {}]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(listRemoteXrayClients(node)).rejects.toThrow(
      "client entry has no UUID",
    );
  });
});

describe("addRemoteXrayClient transport payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Reality for an explicitly configured node", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await addRemoteXrayClient(
      { ...node, transport: "reality" },
      "uuid",
      "label",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      uuid: "uuid",
      label: "label",
      transport: "reality",
    });
  });

  it("defaults legacy node fixtures to WS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await addRemoteXrayClient(node, "uuid", "label");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).transport).toBe("ws");
  });
});