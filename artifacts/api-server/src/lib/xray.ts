/**
 * Local Xray-core client management.
 *
 * Used only in the all-in-one Amvera deployment, where the Express backend and
 * Xray-core run in the same container. When `XRAY_CONFIG_PATH` is set, the
 * backend:
 *
 *  1. Persists the client list into the on-disk Xray config (so the client
 *     survives container restarts — see entrypoint.sh, which preserves
 *     `inbounds[0].settings.clients` across re-renders of the config
 *     template on every boot).
 *  2. Pushes the same add/remove live to the *running* Xray process via its
 *     local gRPC API (HandlerService.AlterInbound), instead of restarting the
 *     process. This means issuing or revoking one user's key no longer drops
 *     every other connected user's VPN session for the few seconds a
 *     `supervisorctl restart xray` used to take.
 *
 * In the Replit dev environment `XRAY_CONFIG_PATH` is unset, so all of these
 * become no-ops and key issuance behaves as before (link generated locally,
 * not yet connectable).
 */
import { promises as fs } from "fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";

const CONFIG_PATH = process.env["XRAY_CONFIG_PATH"];

// Local-only loopback address for Xray's gRPC API inbound (see
// deploy/amvera-all-in-one/xray-config.json.template — the "api"
// dokodemo-door inbound listens here). Never exposed outside the container.
const XRAY_API_ADDRESS = process.env["XRAY_API_ADDRESS"] || "127.0.0.1:10085";

// Tag of the VLESS inbound in xray-config.json.template that AlterInbound
// requests target.
const VLESS_INBOUND_TAG = "vless-in";

interface XrayClient {
  id: string;
  email?: string;
  flow?: string;
}

export function isLocalXrayEnabled(): boolean {
  return Boolean(CONFIG_PATH);
}

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readConfig(): Promise<Record<string, any>> {
  const raw = await fs.readFile(CONFIG_PATH!, "utf-8");
  return JSON.parse(raw) as Record<string, any>;
}

async function writeConfig(config: Record<string, any>): Promise<void> {
  const tmp = `${CONFIG_PATH!}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmp, CONFIG_PATH!);
}

function getClients(config: Record<string, any>): XrayClient[] {
  const clients = config?.["inbounds"]?.[0]?.["settings"]?.["clients"];
  if (!Array.isArray(clients)) {
    throw new Error("Unexpected Xray config shape: inbounds[0].settings.clients missing");
  }
  return clients as XrayClient[];
}

// ---------------------------------------------------------------------------
// gRPC client: hand-rolled (no protoc codegen) against a trimmed copy of
// Xray-core's own .proto files (see ./xray-proto). We only need the
// HandlerService.AlterInbound RPC with AddUserOperation/RemoveUserOperation,
// so we skip the full AddInbound/AddOutbound message tree (which pulls in
// core/config.proto's large dependency graph) and load protobufjs types
// directly rather than going through @grpc/proto-loader.
// ---------------------------------------------------------------------------

// esbuild only bundles JS; the raw .proto files are copied next to
// dist/index.mjs at build time (see build.mjs) and loaded from there using
// __dirname, which the build's banner derives from import.meta.url so it
// resolves correctly both in dev (src/lib) and in the bundled dist output.
const PROTO_ROOT = path.join(__dirname, "xray-proto");

let protoRootPromise: Promise<protobuf.Root> | null = null;

function loadProtoRoot(): Promise<protobuf.Root> {
  if (!protoRootPromise) {
    const root = new protobuf.Root();
    // protobufjs's default resolvePath resolves relative imports against the
    // *importing file's* directory, which breaks Xray's proto layout (e.g.
    // app/proxyman/command/command.proto imports "common/protocol/user.proto"
    // meaning "relative to the proto include root", not to command.proto's
    // own directory). Override it to always resolve against our proto root,
    // matching how protoc/proto-loader's includeDirs option works.
    root.resolvePath = (_origin, target) => path.join(PROTO_ROOT, target);
    protoRootPromise = root
      .load(
        ["app/proxyman/command/command.proto", "proxy/vless/account.proto"],
        { keepCase: true },
      )
      .then((loadedRoot) => {
        loadedRoot.resolveAll();
        return loadedRoot;
      });
  }
  return protoRootPromise;
}

// Wraps a protobufjs message in Xray's poor-man's-Any TypedMessage: `type` is
// the fully qualified proto message name, `value` is its serialized bytes.
function toTypedMessage(type: protobuf.Type, payload: object): { type: string; value: Buffer } {
  const err = type.verify(payload);
  if (err) throw new Error(`Invalid ${type.fullName} payload: ${err}`);
  return {
    type: type.fullName.replace(/^\./, ""),
    value: Buffer.from(type.encode(type.create(payload)).finish()),
  };
}

let handlerClient: grpc.Client | null = null;
let alterInboundTypes: {
  AlterInboundRequest: protobuf.Type;
  AlterInboundResponse: protobuf.Type;
  AddUserOperation: protobuf.Type;
  RemoveUserOperation: protobuf.Type;
  User: protobuf.Type;
  Account: protobuf.Type;
} | null = null;

async function getHandlerClient() {
  if (handlerClient && alterInboundTypes) {
    return { client: handlerClient, types: alterInboundTypes };
  }

  const root = await loadProtoRoot();
  const types = {
    AlterInboundRequest: root.lookupType("xray.app.proxyman.command.AlterInboundRequest"),
    AlterInboundResponse: root.lookupType("xray.app.proxyman.command.AlterInboundResponse"),
    AddUserOperation: root.lookupType("xray.app.proxyman.command.AddUserOperation"),
    RemoveUserOperation: root.lookupType("xray.app.proxyman.command.RemoveUserOperation"),
    User: root.lookupType("xray.common.protocol.User"),
    Account: root.lookupType("xray.proxy.vless.Account"),
  };

  const serviceDefinition: grpc.ServiceDefinition = {
    alterInbound: {
      path: "/xray.app.proxyman.command.HandlerService/AlterInbound",
      requestStream: false,
      responseStream: false,
      requestSerialize: (msg: any) => Buffer.from(types.AlterInboundRequest.encode(msg).finish()),
      requestDeserialize: (buf: Buffer) => types.AlterInboundRequest.decode(buf),
      responseSerialize: (msg: any) => Buffer.from(types.AlterInboundResponse.encode(msg).finish()),
      responseDeserialize: (buf: Buffer) => types.AlterInboundResponse.decode(buf),
    },
  };

  const HandlerServiceClient = grpc.makeGenericClientConstructor(serviceDefinition, "HandlerService");
  handlerClient = new HandlerServiceClient(XRAY_API_ADDRESS, grpc.credentials.createInsecure()) as grpc.Client;
  alterInboundTypes = types;

  return { client: handlerClient, types };
}

function alterInbound(operation: { type: string; value: Buffer }): Promise<void> {
  return getHandlerClient().then(
    ({ client, types }) =>
      new Promise<void>((resolve, reject) => {
        const request = types.AlterInboundRequest.create({
          tag: VLESS_INBOUND_TAG,
          operation,
        });
        (client as any).alterInbound(request, (err: grpc.ServiceError | null) => {
          if (err) reject(new Error(`Xray AlterInbound failed: ${err.message}`));
          else resolve();
        });
      }),
  );
}

async function addUserViaGrpc(uuid: string, email: string): Promise<void> {
  const { types } = await getHandlerClient();
  const account = toTypedMessage(types.Account, { id: uuid, flow: "", encryption: "none" });
  const user = types.User.create({ level: 0, email, account });
  const operation = toTypedMessage(types.AddUserOperation, { user });
  await alterInbound(operation);
}

async function removeUserViaGrpc(email: string): Promise<void> {
  const { types } = await getHandlerClient();
  const operation = toTypedMessage(types.RemoveUserOperation, { email });
  await alterInbound(operation);
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures — callers in vpnKeys.ts don't need to
// change) backed by the persisted-file + live-gRPC-push combo above.
// ---------------------------------------------------------------------------

export async function addXrayClient(uuid: string, email: string): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    if (clients.some((c) => c.id === uuid)) return;
    clients.push({ id: uuid, email });
    // Persist first so the client survives a container restart even if the
    // live gRPC push below fails; the caller still surfaces the error (see
    // vpnKeys.ts), and a retry or the next redeploy will pick this client up.
    await writeConfig(config);
    await addUserViaGrpc(uuid, email);
  });
}

export async function removeXrayClient(uuid: string): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    const existing = clients.find((c) => c.id === uuid);
    if (!existing) return;
    const next = clients.filter((c) => c.id !== uuid);
    config["inbounds"][0]["settings"]["clients"] = next;
    await writeConfig(config);
    // Xray identifies users by `email`, not by our uuid — use the email we
    // recorded for this client when it was added.
    await removeUserViaGrpc(existing.email ?? uuid);
  });
}
