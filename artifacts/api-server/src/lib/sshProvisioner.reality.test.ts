import { describe, expect, it } from "vitest";
import { parseRealityX25519Output } from "./sshProvisioner";

describe("parseRealityX25519Output", () => {
  const privateKey = "A".repeat(43);
  const publicKey = "B".repeat(43);

  it("parses the current Xray PrivateKey and Password (PublicKey) labels", () => {
    const output = [
      `PrivateKey: ${privateKey}`,
      `Password (PublicKey): ${publicKey}`,
      "Hash32: ignored",
    ].join("\n");

    expect(parseRealityX25519Output(output)).toEqual({ privateKey, publicKey });
  });

  it("accepts legacy spaced Private key and Public key labels", () => {
    const output = `Private key: ${privateKey}\nPublic key: ${publicKey}`;

    expect(parseRealityX25519Output(output)).toEqual({ privateKey, publicKey });
  });

  it("rejects output without a complete valid key pair", () => {
    expect(() => parseRealityX25519Output(`PrivateKey: ${privateKey}`)).toThrow(
      "Не удалось разобрать X25519 Reality-ключи",
    );
    expect(() =>
      parseRealityX25519Output("PrivateKey: short\nPassword (PublicKey): also-short"),
    ).toThrow("Не удалось разобрать X25519 Reality-ключи");
  });
});