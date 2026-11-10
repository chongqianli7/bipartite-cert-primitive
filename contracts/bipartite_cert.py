# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""BipartiteCert: deterministic bipartite-coloring certificate primitive.

One thing: given a small graph plus a 2-coloring of its nodes, decide
whether the coloring is a valid bipartite certificate for that graph.

The leader and every validator independently recompute, for each edge,
coloring[u] != coloring[v]. The full per-edge boolean vector is the
decision-bearing payload: leader and validator vectors must agree
element-wise, exactly, with zero tolerance — no aggregates, no scores,
no thresholds. Any single edge that differs flips the verdict.

Verdicts (fixed enumeration, exactly two):
  - BIPARTITE_OK: every edge joins two different colors.
  - CONFLICT: at least one edge joins two nodes of the same color.
The witness for CONFLICT is the first conflicting edge: its index in
the edge list plus its two endpoints (indices, node names, shared
color). The witness is part of the stored record, never overwritten.

State machine: a case is DECIDED the moment it is created, and it is
terminal — there is no update method, a second create_case with the
same case_id always fails, and the verdict can never change.

No LLM is used: this is pure deterministic graph checking. The
consequence is informational only: no GEN moves, no money, nothing
is payable. Synthetic demo data is sufficient.
"""

import json

from genlayer import *

PROTOCOL = "bipartite-cert-1"
MAX_NODES = 16
MAX_EDGES = 64
MAX_NODE_NAME = 32
MAX_CASE_ID = 64
VERDICT_OK = "BIPARTITE_OK"
VERDICT_CONFLICT = "CONFLICT"


def pack(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def need(ok, code):
    if not ok:
        raise gl.vm.UserError("EXPECTED: " + code)


def unique_pairs(pairs):
    d = {}
    for key, value in pairs:
        need(key not in d, "DUPLICATE_JSON_KEY")
        d[key] = value
    return d


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique_pairs) if isinstance(raw, str) else raw


def compute_edge_results(edges, coloring):
    """Pure function: the full per-edge boolean vector.

    edge_results[i] is True exactly when edge i joins two nodes of
    different colors. This vector is the whole decision: the verdict
    is BIPARTITE_OK iff every entry is True.
    """
    return [coloring[u] != coloring[v] for u, v in edges]


class BipartiteCert(gl.Contract):
    cases: TreeMap[str, str]
    counts: TreeMap[str, u32]
    total_cases: u32
    ok_cases: u32
    conflict_cases: u32

    def __init__(self):
        self.total_cases = u32(0)
        self.ok_cases = u32(0)
        self.conflict_cases = u32(0)

    @gl.public.view
    def get_protocol(self) -> str:
        return pack({
            "protocol": PROTOCOL,
            "max_nodes": MAX_NODES,
            "max_edges": MAX_EDGES,
            "max_node_name": MAX_NODE_NAME,
            "verdicts": [VERDICT_OK, VERDICT_CONFLICT],
            "states": ["DECIDED"],
        })

    @gl.public.view
    def get_case(self, case_id: str) -> str:
        return self.cases.get(case_id, "")

    @gl.public.view
    def get_stats(self) -> str:
        return pack({
            "total_cases": int(self.total_cases),
            "ok_cases": int(self.ok_cases),
            "conflict_cases": int(self.conflict_cases),
        })

    @gl.public.write
    def create_case(self, case_id: str, nodes_json: str, edges_json: str, coloring_json: str) -> str:
        need(type(case_id) is str and 1 <= len(case_id) <= MAX_CASE_ID, "CASE_ID_LENGTH")
        need(not self.cases.get(case_id, ""), "ALREADY_EXISTS")
        need(len(nodes_json) <= 2000 and len(edges_json) <= 4000 and len(coloring_json) <= 500, "INPUT_BOUND")
        nodes = parse(nodes_json)
        edges = parse(edges_json)
        coloring = parse(coloring_json)
        need(type(nodes) is list and 2 <= len(nodes) <= MAX_NODES, "NODE_COUNT_2_16")
        need(all(type(n) is str and 1 <= len(n) <= MAX_NODE_NAME for n in nodes), "NODE_NAME")
        need(len(set(nodes)) == len(nodes), "DUPLICATE_NODE")
        need(type(edges) is list and 1 <= len(edges) <= MAX_EDGES, "EDGE_COUNT_1_64")
        need(all(
            type(e) is list and len(e) == 2 and all(type(x) is int for x in e)
            for e in edges
        ), "EDGE_FORMAT")
        need(all(0 <= u < len(nodes) and 0 <= v < len(nodes) for u, v in edges), "EDGE_INDEX_RANGE")
        need(all(u != v for u, v in edges), "SELF_LOOP")
        need(len(set((u, v) if u < v else (v, u) for u, v in edges)) == len(edges), "DUPLICATE_EDGE")
        need(type(coloring) is list and len(coloring) == len(nodes), "COLORING_LENGTH")
        need(all(c in (0, 1) for c in coloring), "COLORING_VALUES_0_1")

        edge_results = compute_edge_results(edges, coloring)
        verdict = VERDICT_OK if all(edge_results) else VERDICT_CONFLICT
        witness = None
        first_conflict = -1
        if verdict == VERDICT_CONFLICT:
            first_conflict = edge_results.index(False)
            u, v = edges[first_conflict]
            witness = {
                "edge_index": first_conflict,
                "u": u,
                "v": v,
                "node_u": nodes[u],
                "node_v": nodes[v],
                "color": coloring[u],
            }

        case = {
            "id": case_id,
            "nodes": nodes,
            "edges": edges,
            "coloring": coloring,
            "edge_results": edge_results,
            "verdict": verdict,
            "first_conflict_edge_index": first_conflict,
            "witness": witness,
            "state": "DECIDED",
        }
        self.cases[case_id] = pack(case)
        self.total_cases = u32(int(self.total_cases) + 1)
        if verdict == VERDICT_OK:
            self.ok_cases = u32(int(self.ok_cases) + 1)
        else:
            self.conflict_cases = u32(int(self.conflict_cases) + 1)
        return pack({
            "id": case_id,
            "verdict": verdict,
            "edge_results": edge_results,
            "first_conflict_edge_index": first_conflict,
            "witness": witness,
            "state": "DECIDED",
        })
