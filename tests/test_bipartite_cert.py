"""Local mock tests for BipartiteCert. NOT chain consensus evidence.

The real contract source (contracts/bipartite_cert.py) is imported with
a stubbed `genlayer` module: the host fakes the VM so the contract's
deterministic logic can be exercised locally. Passing here proves the
edge recomputation, the verdicts, the witness, and the immutability
guards in this file; on-chain proof comes only from the FINALIZED
transactions in evidence.json.
"""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path


class Map(dict):
    @classmethod
    def __class_getitem__(cls, value):
        return cls


class _Write:
    def __call__(self, f):
        return f

    def payable(self, f):
        return f


identity = lambda f: f


class UserError(Exception):
    pass


host = types.SimpleNamespace(
    Contract=object,
    public=types.SimpleNamespace(view=identity, write=_Write()),
    message=types.SimpleNamespace(sender_address="0x" + "1" * 40, value=0),
    evm=types.SimpleNamespace(contract_interface=identity),
    vm=types.SimpleNamespace(UserError=UserError, Return=object),
    nondet=types.SimpleNamespace(),
)
sdk = types.ModuleType("genlayer")
sdk.gl, sdk.TreeMap, sdk.u32, sdk.u256 = host, Map, int, int
sdk.Address = lambda a: a
sys.modules["genlayer"] = sdk

spec = importlib.util.spec_from_file_location(
    "bipartite_cert", Path(__file__).parents[1] / "contracts" / "bipartite_cert.py"
)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

SQUARE_NODES = ["a", "b", "c", "d"]
SQUARE_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]]


def expect_error(fn, code):
    with unittest.TestCase().assertRaises(UserError) as ctx:
        fn()
    assert code in str(ctx.exception), f"expected {code}, got {ctx.exception}"


class CertTests(unittest.TestCase):
    def setUp(self):
        self.c = r.BipartiteCert()
        self.c.cases, self.c.counts = Map(), Map()
        self.c.total_cases = 0
        self.c.ok_cases = 0
        self.c.conflict_cases = 0

    def create(self, case_id, nodes, edges, coloring):
        return self.c.create_case(
            case_id, json.dumps(nodes), json.dumps(edges), json.dumps(coloring)
        )

    def test_protocol(self):
        p = json.loads(self.c.get_protocol())
        self.assertEqual(p["protocol"], "bipartite-cert-1")
        self.assertEqual(p["verdicts"], ["BIPARTITE_OK", "CONFLICT"])
        self.assertEqual(p["states"], ["DECIDED"])
        self.assertEqual(p["max_nodes"], 16)
        self.assertEqual(p["max_edges"], 64)

    def test_compute_edge_results(self):
        self.assertEqual(
            r.compute_edge_results(SQUARE_EDGES, [0, 1, 0, 1]),
            [True, True, True, True],
        )
        self.assertEqual(
            r.compute_edge_results(SQUARE_EDGES, [0, 1, 0, 0]),
            [True, True, False, False],
        )
        # One flipped color flips exactly one edge entry, nothing else.
        self.assertEqual(
            r.compute_edge_results([[0, 1], [1, 2]], [0, 0, 1]),
            [False, True],
        )
        self.assertEqual(r.compute_edge_results([[0, 1]], [1, 1]), [False])

    def test_good_square_is_ok(self):
        out = json.loads(self.create("good-square", SQUARE_NODES, SQUARE_EDGES, [0, 1, 0, 1]))
        self.assertEqual(out["verdict"], "BIPARTITE_OK")
        self.assertEqual(out["edge_results"], [True, True, True, True])
        self.assertEqual(out["first_conflict_edge_index"], -1)
        self.assertIsNone(out["witness"])
        self.assertEqual(out["state"], "DECIDED")
        stored = json.loads(self.c.get_case("good-square"))
        self.assertEqual(stored["verdict"], "BIPARTITE_OK")
        self.assertEqual(stored["nodes"], SQUARE_NODES)
        self.assertEqual(stored["edges"], SQUARE_EDGES)
        self.assertEqual(stored["coloring"], [0, 1, 0, 1])
        stats = json.loads(self.c.get_stats())
        self.assertEqual(stats, {"total_cases": 1, "ok_cases": 1, "conflict_cases": 0})

    def test_bad_path_is_conflict_with_first_witness(self):
        # 4-node path a-b-c-d, coloring [0,1,1,0]: exactly one same-color
        # edge, b-c. (An even cycle can never have exactly one conflict,
        # so the bad demo case is a path, not the square.)
        out = json.loads(self.create(
            "bad-path", ["a", "b", "c", "d"],
            [[0, 1], [1, 2], [2, 3]], [0, 1, 1, 0],
        ))
        self.assertEqual(out["verdict"], "CONFLICT")
        self.assertEqual(out["edge_results"], [True, False, True])
        self.assertEqual(out["first_conflict_edge_index"], 1)
        self.assertEqual(out["witness"], {
            "edge_index": 1, "u": 1, "v": 2,
            "node_u": "b", "node_v": "c", "color": 1,
        })
        stored = json.loads(self.c.get_case("bad-path"))
        self.assertEqual(stored["witness"]["node_u"], "b")
        stats = json.loads(self.c.get_stats())
        self.assertEqual(stats, {"total_cases": 1, "ok_cases": 0, "conflict_cases": 1})

    def test_first_conflict_wins_when_several_conflict(self):
        # Edges 0 and 2 both conflict; the witness must be edge 0.
        out = json.loads(self.create(
            "two-conflicts", ["a", "b", "c"],
            [[0, 1], [1, 2], [0, 2]], [0, 0, 0],
        ))
        self.assertEqual(out["verdict"], "CONFLICT")
        self.assertEqual(out["edge_results"], [False, False, False])
        self.assertEqual(out["first_conflict_edge_index"], 0)
        self.assertEqual(out["witness"]["edge_index"], 0)
        self.assertEqual(out["witness"]["node_u"], "a")
        self.assertEqual(out["witness"]["node_v"], "b")

    def test_case_is_immutable(self):
        self.create("once", SQUARE_NODES, SQUARE_EDGES, [0, 1, 0, 1])
        expect_error(
            lambda: self.create("once", SQUARE_NODES, SQUARE_EDGES, [0, 1, 0, 0]),
            "ALREADY_EXISTS",
        )
        stored = json.loads(self.c.get_case("once"))
        self.assertEqual(stored["verdict"], "BIPARTITE_OK")
        self.assertEqual(stored["coloring"], [0, 1, 0, 1])

    def test_input_validation(self):
        expect_error(lambda: self.create("", SQUARE_NODES, SQUARE_EDGES, [0, 1, 0, 1]), "CASE_ID_LENGTH")
        expect_error(lambda: self.create("one-node", ["a"], [], [0]), "NODE_COUNT_2_16")
        expect_error(lambda: self.create("dup-node", ["a", "a"], [[0, 1]], [0, 1]), "DUPLICATE_NODE")
        expect_error(lambda: self.create("no-edge", ["a", "b"], [], [0, 1]), "EDGE_COUNT_1_64")
        expect_error(lambda: self.create("bad-edge", ["a", "b"], [[0, 2]], [0, 1]), "EDGE_INDEX_RANGE")
        expect_error(lambda: self.create("self-loop", ["a", "b"], [[0, 0]], [0, 1]), "SELF_LOOP")
        expect_error(
            lambda: self.create("dup-edge", ["a", "b"], [[0, 1], [1, 0]], [0, 1]),
            "DUPLICATE_EDGE",
        )
        expect_error(
            lambda: self.create("short-color", SQUARE_NODES, SQUARE_EDGES, [0, 1, 0]),
            "COLORING_LENGTH",
        )
        expect_error(
            lambda: self.create("bad-color", ["a", "b"], [[0, 1]], [0, 2]),
            "COLORING_VALUES_0_1",
        )
        self.assertEqual(self.c.get_case("missing"), "")
        stats = json.loads(self.c.get_stats())
        self.assertEqual(stats["total_cases"], 0)


if __name__ == "__main__":
    unittest.main()
