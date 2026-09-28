import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const NL1_NODE_HOST = "nl1.hochuto.online";
const PINNED_HOSTS_FILE = "/tmp/nl1-management-known_hosts";

export interface NetworkInterfaceCounters {
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
}

export function parseNl1InterfaceCounters(output: string): NetworkInterfaceCounters {
  const [networkInterface, rxRaw, txRaw] = output.trim().split(/\s+/);
  if (
    !networkInterface ||
    !/^[a-zA-Z0-9_.:-]{1,32}$/.test(networkInterface) ||
    !/^\d+$/.test(rxRaw ?? "") ||
    !/^\d+$/.test(txRaw ?? "")
  ) {
    throw new Error("NL1 returned an invalid network-counter sample");
  }

  const networkRxBytes = Number(rxRaw);
  const networkTxBytes = Number(txRaw);
  if (!Number.isSafeInteger(networkRxBytes) || !Number.isSafeInteger(networkTxBytes)) {
    throw new Error("NL1 network-counter sample exceeds the safe integer range");
  }

  return { networkInterface, networkRxBytes, networkTxBytes };
}

/**
 * Development-only fallback for NL1 because its current management API omits
 * network-interface counters. The SSH command reads the default interface's
 * kernel counters; it does not execute any configuration or mutation command.
 */
export async function readNl1InterfaceCounters(
  nodeHost: string | null | undefined,
): Promise<NetworkInterfaceCounters | null> {
  if (process.env.NODE_ENV !== "development" || nodeHost !== NL1_NODE_HOST) return null;

  const host = process.env.VPS_NL1_HOST;
  const username = process.env.VPS_NL1_USER;
  const password = process.env.VPS_NL1_PASSWORD;
  if (!host || !username || !password) {
    throw new Error("NL1 read-only SSH settings are unavailable");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new Error("NL1 SSH target is invalid");
  }
  if (!existsSync(PINNED_HOSTS_FILE)) {
    throw new Error("Pinned NL1 SSH host key is unavailable");
  }

  const remoteCommand =
    `iface=$(awk 'NR > 1 && $2 == "00000000" { print $1; exit }' /proc/net/route); ` +
    `test -n "$iface"; ` +
    `rx=$(cat "/sys/class/net/$iface/statistics/rx_bytes"); ` +
    `tx=$(cat "/sys/class/net/$iface/statistics/tx_bytes"); ` +
    `printf '%s %s %s\\n' "$iface" "$rx" "$tx"`;
  const args = [
    "-e",
    "ssh",
    "-F",
    "/dev/null",
    "-o",
    `UserKnownHostsFile=${PINNED_HOSTS_FILE}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "PreferredAuthentications=password",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "ConnectTimeout=8",
    `${username}@${host}`,
    remoteCommand,
  ];

  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "sshpass",
      args,
      {
        env: { PATH: process.env.PATH, SSHPASS: password },
        timeout: 10_000,
        maxBuffer: 2_048,
      },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(new Error(`NL1 read-only SSH counter request failed (${String(code ?? "unknown")})`));
          return;
        }
        resolve(stdout);
      },
    );
  });

  return parseNl1InterfaceCounters(output);
}