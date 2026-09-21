import { afterEach, describe, expect, it, vi } from "vitest";
import { listRemoteXrayClients } from "./remoteNode";

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