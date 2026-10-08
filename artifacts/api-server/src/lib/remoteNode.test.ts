import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addRemoteXrayClient,
  getRemoteRealityIdentity,
  listRemoteXrayClients,
} from "./remoteNode";

const node = {
  name: "Remote test node",
  managementApiUrl: "https://remote.example.com",
  managementApiSecret: "test-secret",
};

const realityNode = {
  ...node,
  transport: "reality" as const,
  port: 443,
  sni: "example.com",
  publicKey: "test-public-key",
  shortId: "0123456789abcdef",
};

const realityIdentity = {
  publicKey: "test-public-key",
  port: 443,
  network: "tcp",
  security: "reality",
  serverNames: ["example.com"],
  shortIds: ["0123456789abcdef"],
  dest: "example.com:443",
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

  it("normalizes the inbound transport and assumes WS only for legacy WS nodes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "ws-uuid", email: "ws-uuid" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listRemoteXrayClients(node)).resolves.toEqual([
      { uuid: "ws-uuid", label: "ws-uuid", limitIp: null, transport: "ws" },
    ]);
  });

  it("rejects a Reality inventory that omits transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "reality-uuid", email: "reality-uuid" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(listRemoteXrayClients(realityNode)).rejects.toThrow(
      "client entry has no valid transport",
    );
  });
});

describe("getRemoteRealityIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses only the public profile returned by the node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(realityIdentity), { status: 200 }),
      ),
    );

    await expect(getRemoteRealityIdentity(realityNode)).resolves.toEqual(
      realityIdentity,
    );
  });
});

describe("addRemoteXrayClient transport payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks the live Reality identity and verifies client placement", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(realityIdentity), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "uuid",
              email: "uuid",
              limitIp: 1,
              transport: "reality",
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await addRemoteXrayClient(realityNode, "uuid", "label", 1);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://remote.example.com/reality/identity",
    );
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toMatchObject({
      uuid: "uuid",
      label: "label",
      limitIp: 1,
      transport: "reality",
    });
  });

  it("refuses to provision when the stored public key differs from the live Xray key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ...realityIdentity, publicKey: "different-public-key" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(addRemoteXrayClient(realityNode, "uuid", "label")).rejects.toThrow(
      "Reality node settings do not match the running Xray configuration",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a server that reports the UUID under WS instead of Reality", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(realityIdentity), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "uuid", email: "uuid", transport: "ws" }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(addRemoteXrayClient(realityNode, "uuid", "label")).rejects.toThrow(
      "did not install the client exclusively on the Reality inbound",
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  it("defaults legacy node fixtures to WS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await addRemoteXrayClient(node, "uuid", "label");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).transport).toBe("ws");
  });
});