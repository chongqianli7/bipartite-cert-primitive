/* Independent re-check for BipartiteCert: re-reads the live contract
 * state and compares it against evidence.json. No writes, no new transactions.
 *
 * Usage: node scripts/verify.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const evidence = JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf-8"));
const address = deployment.contractAddress;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const RETRYABLE = /html|429|rate limit|too many|ECONNRESET|ETIMEDOUT|fetch failed|Unexpected token|Service Unavailable|Bad Gateway|Gateway Timeout|temporarily|RLP|internal error|InternalRpcError|32603/i;
async function withRetry(fn, label, maxAttempts = 10) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts || !RETRYABLE.test(String(e?.message || e))) throw e;
      console.log(`  [retry ${label} ${attempt}/${maxAttempts}]`);
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}
async function readJson(functionName, args = []) {
  const raw = await withRetry(
    () => reader.readContract({ address, functionName, args }),
    `read ${functionName}`,
  );
  return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[")) ? JSON.parse(raw) : raw;
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("Contract:", address);
console.log("Explorer:", deployment.explorer);

// 1. Deployed code still matches the source file.
const { createHash } = await import("node:crypto");
const code = readFileSync(path.join(root, "contracts", "bipartite_cert.py"), "utf-8");
check("source SHA matches deployment.json", createHash("sha256").update(code).digest("hex") === deployment.contractSha256);
const cc = await withRetry(() => reader.request({ method: "gen_getContractCode", params: [address] }), "gen_getContractCode");
let decoded = null;
try { decoded = Buffer.from(cc, "base64").toString("utf-8"); } catch { /* ignore */ }
if (decoded !== code && cc === code) decoded = cc;
check("live deployed code matches source", decoded === code);

function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 2. Cases re-read live match evidence.json.
for (const c of evidence.cases) {
  const live = await readJson("get_case", [c.id]);
  check(`${c.id} verdict ${c.expected_verdict}`, live.verdict === c.expected_verdict);
  check(`${c.id} edge_results match evidence`,
    canon(live.edge_results) === canon(c.expected_edge_results));
  check(`${c.id} witness matches evidence`,
    canon(live.witness) === canon(c.expected_witness));
  check(`${c.id} state DECIDED`, live.state === "DECIDED");
  check(`${c.id} inputs stored`, JSON.stringify(live.nodes) === JSON.stringify(c.nodes)
    && JSON.stringify(live.edges) === JSON.stringify(c.edges)
    && JSON.stringify(live.coloring) === JSON.stringify(c.coloring));
}

// 3. Stats.
const stats = await readJson("get_stats", []);
check("stats total 2 / ok 1 / conflict 1",
  stats.total_cases === 2 && stats.ok_cases === 1 && stats.conflict_cases === 1);

// 4. Every recorded transaction is FINALIZED.
for (const tx of evidence.transactions) {
  check(`tx ${tx.label} FINALIZED`, tx.receiptStatus === "FINALIZED", tx.txHash);
}

console.log(failures === 0 ? "\nVERIFY: ALL CHECKS PASS" : `\nVERIFY: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
