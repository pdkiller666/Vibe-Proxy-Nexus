import { describe, expect, it } from "vitest";
import { parseNl1InterfaceCounters } from "./nl1InterfaceCounters";

describe("parseNl1InterfaceCounters", () => {
  it("parses the interface name and cumulative byte counters", () => {
    expect(parseNl1InterfaceCounters("ens3 12345 67890\n")).toEqual({
      networkInterface: "ens3",
      networkRxBytes: 12345,
      networkTxBytes: 67890,
    });
  });

  it("rejects malformed samples", () => {
    expect(() => parseNl1InterfaceCounters("ens3 unknown 67890")).toThrow();
    expect(() => parseNl1InterfaceCounters("bad/interface 1 2")).toThrow();
  });
});