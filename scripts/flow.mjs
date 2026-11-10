/* On-chain evidence flow for BipartiteCert on Stable Studionet.
 *
 * Usage: node scripts/flow.mjs   (uses deployment.json for the address)
 *
 * Ephemeral accounts only (keys never written to disk). One account is
 * funded 100 GEN from the faucet simulation (sim_fundAccount; real
 * testnet GEN, zero cash cost). No GEN ever moves: create_case is not
 * payable and the verdict is informational only.
 *
 * Flow (3 writes + 1 deploy = 4 transactions):
 *   GOOD: 4-node square a-b-c-d-a, coloring [0,1,0,1]
 *         -> BIPARTITE_OK, edge_results [true,true,true,true]
 *   BAD:  4-node path a-b-c-d, coloring [0,1,1,0]
 *         -> CONFLICT, edge_results [true,false,true],
 *            witness = edge 1 (b-c, color 1)
 *   DUP:  create good-square again with the same case_id
 *         -> ERROR ALREADY_EXISTS; the stored verdict is unchanged
 *         (proves the record is immutable once decided)
 *
 * RPC discipline: reads retry with exponential back-off; receipts are
 * polled slowly (12 s); a write is submitted exactly ONCE per attempt
 * and never re-submitted on a polling failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- accounts (ephemeral; keys never leave this process) --------------------
const creator = createAccount(generatePrivateKey());
console.log(`creator: ${creator.address}`);
console.log("Contract:", address);

const clientFor = (account) => createClient({ chain: studionet, account });
const reader = clientFor(creator);

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  deployTxHash: deployment.deployTxHash,
  contractFile: "contracts/bipartite_cert.py",
  contractSha256: deployment.contractSha256,
  deployedCodeSha256: deployment.deployedCodeSha256,
  deployedCodeMatchesSource: deployment.deployedCodeMatchesSource,
  accounts: { creator: creator.address },
  funding: {},
  cases: [],
  transactions: [],
  finalReadbacks: null,
  generatedAt: new Date().toISOString(),
};
const save = () => writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");

// --- rate-limit-aware reads --------------------------------------------------
const RETRYABLE = /html|429|rate limit|too many|ECONNRESET|ETIMEDOUT|fetch failed|Unexpected token|Service Unavailable|Bad Gateway|Gateway Timeout|temporarily|RLP|internal error|InternalRpcError|32603/i;
function retryAfterMs(err) {
  let node = err;
  for (let i = 0; i < 5 && node; i++) {
    const secs = node?.data?.retry_after_seconds ?? node?.cause?.data?.retry_after_seconds;
    if (typeof secs === "number" && secs > 0) return Math.min(secs * 1000, 1500000);
    if (typeof node?.message === "string" && /rate limit/i.test(node.message)) {
      const m = node.message.match(/retry_after_seconds\D*(\d+)/);
      if (m) return Math.min(Number(m[1]) * 1000, 1500000);
    }
    node = node?.cause;
  }
  return null;
}
async function withRetry(fn, label, maxAttempts = 15) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await fn();
      if (typeof out === "string" && out.trimStart().startsWith("<")) {
        throw new Error("HTML error page instead of JSON");
      }
      return out;
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt === maxAttempts || !RETRYABLE.test(msg)) throw e;
      const wait = retryAfterMs(e) ?? delay;
      console.log(`  [retry ${label} attempt ${attempt}/${maxAttempts} after ${Math.round(wait / 1000)}s: ${msg.slice(0, 120)}]`);
      await sleep(wait);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

async function rpc(method, params) {
  return withRetry(() => reader.request({ method, params }), `rpc ${method}`);
}

async function readJson(functionName, args = []) {
  const raw = await withRetry(
    () => reader.readContract({ address, functionName, args }),
    `read ${functionName}`,
  );
  if (typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("["))) return JSON.parse(raw);
  return raw;
}

// --- receipt polling (slow; never re-submits) --------------------------------
const STATUS = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const statusOf = (r) => r.status_name ?? r.statusName ?? STATUS[r.status] ?? String(r.status ?? "");
const resultOf = (r) => r.result_name ?? r.resultName ?? "";
function leaderOf(receipt) {
  const list = receipt.consensus_data?.leader_receipt || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.find((x) => x.mode === "leader") || arr[arr.length - 1] || {};
}

function decodeResultField(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf-8").replace(/^[^\x20-\x7E]+/, "");
  } catch {
    return "";
  }
}
function errorTextOf(leader) {
  const fromResult = decodeResultField(leader.result);
  const fromStderr = (leader.genvm_result?.stderr || leader.stderr || "").toString();
  return [fromResult, fromStderr].filter(Boolean).join("\n");
}

async function pollReceipt(hash, label, maxPolls = 40, intervalMs = 12000) {
  for (let i = 0; i < maxPolls; i++) {
    const receipt = await rpc("eth_getTransactionByHash", [hash]);
    if (receipt && (statusOf(receipt) === "FINALIZED" || statusOf(receipt) === "CANCELED")) {
      return receipt;
    }
    if (i % 5 === 0) console.log(`  ${label}: waiting (${statusOf(receipt || {}) || "unknown"}), poll ${i + 1}/${maxPolls}`);
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not finalize after ${maxPolls} polls (tx ${hash})`);
}

// --- writes: submitted exactly once per attempt ------------------------------
async function write(account, functionName, args, label, expectError = null) {
  const client = clientFor(account);
  const hash = await client.writeContract({ address, functionName, args, leaderOnly: false });
  console.log(`${label} tx: ${hash}`);
  const receipt = await pollReceipt(hash, label);
  const status = statusOf(receipt);
  const consensus = resultOf(receipt);
  const leader = leaderOf(receipt);
  const execution = leader.execution_result || leader.executionResult || "";
  const stderr = errorTextOf(leader);
  const record = {
    label,
    method: functionName,
    args: JSON.parse(JSON.stringify(args)),
    sender: account.address,
    txHash: hash,
    receiptStatus: status,
    consensus,
    execution,
    expected_error: expectError,
    stderr_excerpt: stderr.slice(0, 500),
  };
  evidence.transactions.push(record);
  save();
  if (status !== "FINALIZED") throw new Error(`${label} ended ${status}, not FINALIZED (tx ${hash})`);
  if (consensus !== "MAJORITY_AGREE") throw new Error(`${label} consensus ${consensus}, not MAJORITY_AGREE (tx ${hash})`);
  if (expectError) {
    if (execution !== "ERROR") throw new Error(`${label} expected ERROR but leader executed ${execution} (tx ${hash})`);
    if (!stderr.includes(expectError)) {
      throw new Error(`${label} expected error ${expectError} but stderr was: ${stderr.slice(0, 300)} (tx ${hash})`);
    }
    console.log(`  ${label}: FINALIZED / MAJORITY_AGREE / ERROR (${expectError}) as expected`);
  } else {
    if (execution !== "SUCCESS") throw new Error(`${label} expected SUCCESS but leader executed ${execution}: ${stderr.slice(0, 300)} (tx ${hash})`);
    console.log(`  ${label}: FINALIZED / MAJORITY_AGREE / SUCCESS`);
  }
  return { hash, receipt, record };
}

function assertEq(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function assertDeep(actual, expected, label) {
  if (canon(actual) !== canon(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function pollUntil(label, fn, ok, timeoutMs = 90000, intervalMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${label}: state did not appear within ${timeoutMs / 1000}s; last value: ${JSON.stringify(last).slice(0, 400)}`);
    }
    await sleep(intervalMs);
  }
}

// ===========================================================================
// Main flow
// ===========================================================================
console.log("Flow start:", new Date().toISOString());

// --- 0. fund the creator (writes need a funded account; no GEN ever moves) --
{
  const fundTx = await withRetry(
    () => clientFor(creator).request({ method: "sim_fundAccount", params: [creator.address, 100 * 10 ** 18] }),
    "fund creator",
  );
  const bal = await withRetry(() => reader.getBalance({ address: creator.address }), "balance creator");
  assertEq(BigInt(bal.toString()), 100n * 10n ** 18n, "fund creator balance");
  evidence.funding.creator = { address: creator.address, funded_gen: 100, fundTx: String(fundTx), balance_after_wei: bal.toString() };
  console.log(`fund creator: balance 100 GEN`);
}
save();

// --- preflight: fresh contract ------------------------------------------------
{
  const pre = await readJson("get_stats", []);
  if (pre.total_cases !== 0) {
    throw new Error(`contract is not fresh: total_cases is ${pre.total_cases}, expected 0. Redeploy a fresh contract before running the flow.`);
  }
  console.log("  preflight: fresh contract (0 cases)");
}

// --- GOOD: 4-node square, alternating colors ---------------------------------
const goodNodes = ["a", "b", "c", "d"];
const goodEdges = [[0, 1], [1, 2], [2, 3], [3, 0]];
const goodColoring = [0, 1, 0, 1];
console.log("\n--- GOOD: square a-b-c-d-a, coloring [0,1,0,1] ---");
const createGood = await write(
  creator, "create_case",
  ["good-square", JSON.stringify(goodNodes), JSON.stringify(goodEdges), JSON.stringify(goodColoring)],
  "create-good-square",
);
{
  const back = await pollUntil(
    "good-square readback",
    () => readJson("get_case", ["good-square"]),
    (b) => b.id === "good-square" && b.verdict === "BIPARTITE_OK",
  );
  assertDeep(back.edge_results, [true, true, true, true], "good-square edge_results");
  assertEq(back.first_conflict_edge_index, -1, "good-square first_conflict");
  assertEq(back.witness, null, "good-square witness");
  assertEq(back.state, "DECIDED", "good-square state");
  console.log("  good-square: BIPARTITE_OK, edge_results [true,true,true,true], witness null");
}
evidence.cases.push({
  id: "good-square",
  nodes: goodNodes,
  edges: goodEdges,
  coloring: goodColoring,
  expected_verdict: "BIPARTITE_OK",
  expected_edge_results: [true, true, true, true],
  expected_witness: null,
  createTxHash: createGood.hash,
});
save();

// --- BAD: 4-node path, one same-color edge ------------------------------------
const badNodes = ["a", "b", "c", "d"];
const badEdges = [[0, 1], [1, 2], [2, 3]];
const badColoring = [0, 1, 1, 0];
console.log("\n--- BAD: path a-b-c-d, coloring [0,1,1,0] ---");
const createBad = await write(
  creator, "create_case",
  ["bad-path", JSON.stringify(badNodes), JSON.stringify(badEdges), JSON.stringify(badColoring)],
  "create-bad-path",
);
{
  const back = await pollUntil(
    "bad-path readback",
    () => readJson("get_case", ["bad-path"]),
    (b) => b.id === "bad-path" && b.verdict === "CONFLICT",
  );
  assertDeep(back.edge_results, [true, false, true], "bad-path edge_results");
  assertEq(back.first_conflict_edge_index, 1, "bad-path first_conflict");
  assertDeep(back.witness, {
    edge_index: 1, u: 1, v: 2, node_u: "b", node_v: "c", color: 1,
  }, "bad-path witness");
  assertEq(back.state, "DECIDED", "bad-path state");
  console.log("  bad-path: CONFLICT, edge_results [true,false,true], witness edge 1 (b-c, color 1)");
}
evidence.cases.push({
  id: "bad-path",
  nodes: badNodes,
  edges: badEdges,
  coloring: badColoring,
  expected_verdict: "CONFLICT",
  expected_edge_results: [true, false, true],
  expected_witness: { edge_index: 1, u: 1, v: 2, node_u: "b", node_v: "c", color: 1 },
  createTxHash: createBad.hash,
});
save();

// --- DUP: same case_id again must fail; stored verdict unchanged -------------
console.log("\n--- DUP: create good-square again (must fail ALREADY_EXISTS) ---");
await write(
  creator, "create_case",
  ["good-square", JSON.stringify(goodNodes), JSON.stringify(goodEdges), JSON.stringify(goodColoring)],
  "duplicate-create-good-square", "ALREADY_EXISTS",
);
{
  const back = await readJson("get_case", ["good-square"]);
  assertEq(back.verdict, "BIPARTITE_OK", "duplicate create changed good-square verdict");
  assertDeep(back.coloring, [0, 1, 0, 1], "duplicate create changed good-square coloring");
  console.log("  good-square still BIPARTITE_OK after duplicate create attempt");
}

// --- final read-backs -----------------------------------------------------------
console.log("\n--- final read-backs ---");
const finalGood = await readJson("get_case", ["good-square"]);
const finalBad = await readJson("get_case", ["bad-path"]);
const finalStats = await readJson("get_stats", []);
assertEq(finalStats.total_cases, 2, "final total_cases");
assertEq(finalStats.ok_cases, 1, "final ok_cases");
assertEq(finalStats.conflict_cases, 1, "final conflict_cases");
console.log("  final stats:", JSON.stringify(finalStats));

evidence.finalReadbacks = {
  cases: [finalGood, finalBad],
  stats: finalStats,
  readBackAt: new Date().toISOString(),
};
evidence.generatedAt = new Date().toISOString();
save();
console.log("\nFLOW COMPLETE. Wrote evidence.json with", evidence.transactions.length, "transactions.");
