/**
 * TEST-ONLY: rewrite the node graph of a real MainNet prepared transaction.
 * Not shipped: excluded from the build in tsconfig.json. Also imported by the
 * facilitator and agent-wallet tests.
 *
 * The base is a real `TransferFactory_Transfer`: root "0" with children
 * 1-4, and node "4" (`TransferPreapproval_SendV2`) with children 5-11.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PreparedTransaction } from "@canton-network/core-ledger-proto";
import { hashPreparedTransaction } from "@canton-network/core-tx-visualizer";

export const REAL_PREPARED_B64 = readFileSync(
  fileURLToPath(
    new URL(
      "../../agent-wallet/src/__fixtures__/mainnet-transfer-preapproval-0.1.21.b64",
      import.meta.url
    )
  ),
  "utf8"
).trim();

type Tx = NonNullable<PreparedTransaction["transaction"]>;
type TxNode = Tx["nodes"][number];

function decode(): PreparedTransaction {
  return PreparedTransaction.fromBinary(Buffer.from(REAL_PREPARED_B64, "base64"));
}

function encode(prepared: PreparedTransaction): string {
  return Buffer.from(PreparedTransaction.toBinary(prepared)).toString("base64");
}

function tx(prepared: PreparedTransaction): Tx {
  if (!prepared.transaction) throw new Error("fixture has no transaction");
  return prepared.transaction;
}

function node(prepared: PreparedTransaction, id: string): TxNode {
  const found = tx(prepared).nodes.find((n) => n.nodeId === id);
  if (!found) throw new Error(`fixture has no node ${id}`);
  return found;
}

/** The children list of an exercise node, mutable in place. */
export function exerciseChildren(prepared: PreparedTransaction, id: string): string[] {
  const versioned = node(prepared, id).versionedNode;
  if (versioned.oneofKind !== "v1") throw new Error(`node ${id} is not v1`);
  const type = versioned.v1.nodeType;
  if (type.oneofKind !== "exercise") throw new Error(`node ${id} is not an exercise`);
  return type.exercise.children;
}

/** The create, exercise or fetch body of node `id`, mutable in place. */
export function nodeBody(prepared: PreparedTransaction, id: string) {
  const versioned = node(prepared, id).versionedNode;
  if (versioned.oneofKind !== "v1") throw new Error(`node ${id} is not v1`);
  const type = versioned.v1.nodeType;
  if (type.oneofKind === "create") return type.create;
  if (type.oneofKind === "exercise") return type.exercise;
  if (type.oneofKind === "fetch") return type.fetch;
  throw new Error(`node ${id} has no template`);
}

/** The real transaction with `change` applied to its decoded form, base64. */
export function mutated(change: (prepared: PreparedTransaction) => void): string {
  const prepared = decode();
  change(prepared);
  return encode(prepared);
}

/**
 * Append `count` unreferenced copies of fetch node "3" with fresh ids. The real
 * transaction references every node once, so one extra edge already exceeds the
 * node count; spare nodes leave room for the walk itself to meet the edge.
 */
export function addSpareNodes(prepared: PreparedTransaction, count: number): void {
  const t = tx(prepared);
  const spare = node(prepared, "3");
  for (let i = 0; i < count; i++) {
    t.nodes.push({ ...structuredClone(spare), nodeId: String(900 + i) });
  }
}

/** Rename node `from` to `to`, everywhere it is named. */
export function renameNode(prepared: PreparedTransaction, from: string, to: string): void {
  const t = tx(prepared);
  node(prepared, from).nodeId = to;
  t.roots = t.roots.map((r) => (r === from ? to : r));
  for (const n of t.nodes) {
    const versioned = n.versionedNode;
    if (versioned.oneofKind !== "v1") continue;
    const type = versioned.v1.nodeType;
    if (type.oneofKind === "exercise") {
      type.exercise.children = type.exercise.children.map((c) => (c === from ? to : c));
    }
  }
}

/** The hash the library computes with no graph check. It never returns on a
 *  cycle: call it only on graphs without one. */
export async function libraryHashHex(b64: string): Promise<string> {
  return Buffer.from(await hashPreparedTransaction(b64, "base64"), "base64").toString("hex");
}

/**
 * A chain of `depth` exercise nodes, each a copy of the real childless
 * exercise "8" with its own id and seed, so the hasher can encode every node.
 * Each node lists the next one `fanout` times.
 */
export function chain(depth: number, fanout = 1): string {
  return mutated((prepared) => {
    const t = tx(prepared);
    const template = node(prepared, "8");
    const seed = t.nodeSeeds.find((s) => s.nodeId === 8);
    if (!seed) throw new Error("fixture has no seed for node 8");
    const ids = Array.from({ length: depth }, (_, i) => String(100 + i));
    t.nodes = ids.map((id, i) => {
      const copy = structuredClone(template);
      copy.nodeId = id;
      const next = ids[i + 1];
      const versioned = copy.versionedNode;
      if (versioned.oneofKind === "v1" && versioned.v1.nodeType.oneofKind === "exercise") {
        versioned.v1.nodeType.exercise.children = next ? Array(fanout).fill(next) : [];
      }
      return copy;
    });
    t.roots = [ids[0] as string];
    t.nodeSeeds = ids.map((id) => ({ ...structuredClone(seed), nodeId: Number(id) }));
  });
}

/** `count` id-only nodes, no roots: only the node-count limit applies. */
export function manyNodes(count: number): string {
  return mutated((prepared) => {
    const t = tx(prepared);
    t.nodes = Array.from({ length: count }, (_, i) => ({
      nodeId: String(i),
      versionedNode: { oneofKind: undefined },
    }));
    t.roots = [];
    t.nodeSeeds = [];
  });
}
