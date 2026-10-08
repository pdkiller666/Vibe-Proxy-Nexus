import { describe, expect, it } from "vitest";
import {
  buildSelfSignedCertificateCommand,
  buildRealityUfwCommands,
  normalizeAmveraEgressIp,
  parseSha256CertificateFingerprint,
  parseRealityX25519Output,
} from "./sshProvisioner";

describe("AMVERA_EGRESS_IP firewall configuration", () => {
  it("accepts a single IP address or valid IPv4/IPv6 CIDR", () => {
    expect(normalizeAmveraEgressIp(" 203.0.113.10 ")).toBe("203.0.113.10");
    expect(normalizeAmveraEgressIp("203.0.113.0/24")).toBe("203.0.113.0/24");
    expect(normalizeAmveraEgressIp("2001:db8::/48")).toBe("2001:db8::/48");
  });

  it("treats an empty value as unset and rejects invalid or injectable values", () => {
    expect(normalizeAmveraEgressIp(undefined)).toBeNull();
    expect(normalizeAmveraEgressIp("  ")).toBeNull();
    expect(() => normalizeAmveraEgressIp("203.0.113.1/33")).toThrow("invalid CIDR prefix");
    expect(() => normalizeAmveraEgressIp("203.0.113.1; touch /tmp/pwned")).toThrow("IP address or CIDR");
  });

  it("removes the broad API rule and permits only the configured source", () => {
    const commands = buildRealityUfwCommands("203.0.113.10/32").join(" && ");
    expect(commands).toContain("ufw --force delete allow 8443/tcp");
    expect(commands).toContain("ufw allow from '203.0.113.10/32' to any port 8443 proto tcp");
    expect(commands).not.toContain("ufw allow 8443/tcp comment VPN-MgmtAPI");
  });

  it("preserves the documented open fallback when no Amvera egress address is set", () => {
    expect(buildRealityUfwCommands(null)).toContain("ufw allow 8443/tcp comment VPN-MgmtAPI");
  });
});

describe("buildSelfSignedCertificateCommand", () => {
  it("adds a DNS SAN for a domain-backed self-signed certificate", () => {
    const command = buildSelfSignedCertificateCommand(
      "node.example.test",
      "/etc/ssl/vpn-node/cert.pem",
      "/etc/ssl/vpn-node/key.pem",
    );
    expect(command).toContain("-addext 'subjectAltName=DNS:node.example.test'");
    expect(command).toContain("-subj '/CN=node.example.test'");
  });

  it("adds an IP SAN when the node address is an IP", () => {
    const command = buildSelfSignedCertificateCommand(
      "203.0.113.10",
      "/etc/ssl/vpn-node/cert.pem",
      "/etc/ssl/vpn-node/key.pem",
    );
    expect(command).toContain("-addext 'subjectAltName=IP:203.0.113.10'");
  });
});

describe("parseSha256CertificateFingerprint", () => {
  it("accepts a canonical 32-byte base64 SHA-256 fingerprint", () => {
    const fingerprint = Buffer.alloc(32, 0xab).toString("base64");
    expect(parseSha256CertificateFingerprint(fingerprint)).toBe(fingerprint);
  });

  it("rejects missing, truncated, hex, and non-canonical fingerprints", () => {
    expect(() => parseSha256CertificateFingerprint("")).toThrow("fingerprint TLS-сертификата");
    expect(() => parseSha256CertificateFingerprint("YWJj")).toThrow("fingerprint TLS-сертификата");
    expect(() => parseSha256CertificateFingerprint("a".repeat(64))).toThrow("fingerprint TLS-сертификата");
    expect(() => parseSha256CertificateFingerprint(`${"A".repeat(42)}B=`)).toThrow("fingerprint TLS-сертификата");
  });
});

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