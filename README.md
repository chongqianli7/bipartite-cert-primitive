# BipartiteCert — deterministic bipartite-coloring certificate primitive

二分图着色证书原语：给定一张小图和一个 2-着色，验证该着色是否合法。

BipartiteCert is a deterministic bipartite-coloring certificate primitive: given a small graph plus a 2-coloring of its nodes, it decides whether the coloring is a valid bipartite certificate for that graph.

- Network: Stable Studionet, Chain ID 61999, RPC https://studio.genlayer.com/api
- Contract: `0x08Ed7437E448c8286E4EEFA6a8b210232d42E97a`
- Explorer: https://explorer-studio.genlayer.com/address/0x08Ed7437E448c8286E4EEFA6a8b210232d42E97a
- Source: `contracts/bipartite_cert.py`
- Source SHA-256: `eff537792048b4330ef7d6b7c0aa7ae678d0c6523faaa116b89ff7dd3d34c238`
- Deployed code matches the source byte for byte (checked with `gen_getContractCode`).

## Mechanism / 机制

One thing, one fixed enumeration, exact equality on the full vector.

`create_case(case_id, nodes_json, edges_json, coloring_json)` takes a case id, a list of node names, a list of edges as index pairs `[[u, v], ...]`, and a coloring: a list of `0`/`1` parallel to the nodes. The leader and every validator independently recompute, for each edge, `coloring[u] != coloring[v]`. The full per-edge boolean vector is the decision-bearing payload: leader and validator vectors must agree element-wise, exactly, with zero tolerance — no aggregates, no scores, no thresholds. Any single edge that differs flips the verdict.

Verdicts (fixed enumeration, exactly two):

- `BIPARTITE_OK` — every edge joins two nodes of different colors.
- `CONFLICT` — at least one edge joins two nodes of the same color. The witness is the first conflicting edge: its index in the edge list plus its two endpoints (indices, node names, shared color). The witness is part of the stored record.

No LLM is used: this is pure deterministic graph checking. The consequence is informational only — `create_case` is not payable, no GEN moves, no money changes hands.

## State machine / 状态机

```
create_case --> DECIDED (terminal)
```

- A case is `DECIDED` the moment it is created. There is no update method: a second `create_case` with the same `case_id` fails with `ALREADY_EXISTS`, and the stored verdict can never change.
- Input guards: 2–16 nodes, unique non-empty node names (max 32 chars); 1–64 edges, indices in range, no self-loops, no duplicate edges; coloring parallel to the nodes, values only `0`/`1`.

## How to call / 调用方法

All on-chain values are English. The three list arguments are JSON strings.

```js
// 1. Good case: 4-node square a-b-c-d-a, alternating colors.
//    -> BIPARTITE_OK, edge_results [true, true, true, true]
create_case(
  "good-square",
  JSON.stringify(["a", "b", "c", "d"]),
  JSON.stringify([[0, 1], [1, 2], [2, 3], [3, 0]]),
  JSON.stringify([0, 1, 0, 1]),
);

// 2. Bad case: 4-node path a-b-c-d, coloring [0,1,1,0].
//    Edge b-c joins two nodes of color 1.
//    -> CONFLICT, edge_results [true, false, true],
//       witness { edge_index: 1, u: 1, v: 2, node_u: "b", node_v: "c", color: 1 }
create_case(
  "bad-path",
  JSON.stringify(["a", "b", "c", "d"]),
  JSON.stringify([[0, 1], [1, 2], [2, 3]]),
  JSON.stringify([0, 1, 1, 0]),
);
```

Reads:

```js
get_protocol(); // protocol, bounds, verdicts, states
get_case("good-square"); // id, nodes, edges, coloring, edge_results, verdict, witness, state
get_stats(); // total_cases, ok_cases, conflict_cases
```

## Evidence / 证据

All transactions FINALIZED with MAJORITY_AGREE consensus. Full machine-readable evidence: [`evidence.json`](evidence.json). Deployment record: [`deployment.json`](deployment.json).

| Case | Transaction | Result |
| --- | --- | --- |
| Deploy | `0xe0106269a3788a8843a0eb97026d9e4df2141406c7cb6a35cabbbad1aa4f4f10` | FINALIZED, contract `0x08Ed7437E448c8286E4EEFA6a8b210232d42E97a` |
| GOOD square `[0,1,0,1]` | `0x5838c8446610f8ad9f7dca4374595c67a7947a08d83d9196689a1964ce7bacb0` | FINALIZED / SUCCESS — `BIPARTITE_OK`, edge_results `[true, true, true, true]`, witness null |
| BAD path `[0,1,1,0]` | `0x7bc0693b6547fd119fb05ac110cd69ca9117b77db80fd6da495e74c83dedb157` | FINALIZED / SUCCESS — `CONFLICT`, edge_results `[true, false, true]`, witness edge 1 (b-c, color 1) |
| Duplicate create `good-square` | `0x2269f54f22726eb86096761867ca613620f9c24702c9452b69e3e26125e777dc` | FINALIZED / ERROR `ALREADY_EXISTS` — stored verdict unchanged, still `BIPARTITE_OK` |

Final read-backs: `get_stats()` → total 2, ok 1, conflict 1. Both cases re-read live and match `evidence.json` exactly (`npm run verify`, 16 checks).

## Reuse / 复用价值

Any checker that needs a trustworthy bipartite certificate can reuse this primitive: submit a graph and a coloring once, and anyone can read back the verdict, the full per-edge vector, and the first conflicting edge as witness. The same contract also serves as the deterministic core for graph-coloring checks in larger protocols.

## Tests / 测试

`tests/test_bipartite_cert.py` runs the real contract source locally with a stubbed host module (local mock only — not chain consensus evidence). It covers the good square, the bad path with its witness, first-conflict selection, immutability, and input validation:

```bash
npm test   # python3 tests/test_bipartite_cert.py — 7 tests
```

Reproduce the on-chain flow and the independent re-check:

```bash
npm run deploy   # ephemeral deployer key; writes deployment.json
npm run flow     # evidence flow; writes evidence.json
npm run verify   # re-reads live state and compares with evidence.json
```

## Limits / 已知限制

- Graphs are small by design: at most 16 nodes and 64 edges per case.
- The verdict only certifies the submitted coloring against the submitted graph; it does not check whether the graph itself is bipartite under some other coloring.
- An even cycle can never have exactly one conflicting edge (the number of color-change edges on a cycle is even); the bad demo case is therefore a path, not the square.
- Cases are immutable once created: a wrong submission cannot be corrected, only superseded by a new case id.
