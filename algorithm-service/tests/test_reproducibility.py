from app.models import SolveRequest
from app.solver import solve
from tests.conftest import tiny_request


def test_same_seed_reproducible():
    req = SolveRequest(**tiny_request())
    r1 = solve(req)
    r2 = solve(SolveRequest(**tiny_request()))
    assert r1["feasibleSolution"] and r2["feasibleSolution"]
    assert r1["operations"] == r2["operations"]
    assert r1["kpi"] == r2["kpi"]


def test_different_seed_same_schema():
    req = tiny_request()
    req["algorithm"]["randomSeed"] = 999
    r = solve(SolveRequest(**req))
    assert r["feasibleSolution"]
    assert r["constraintCheck"]["passed"]
    assert len(r["operations"]) == 3
    op = r["operations"][0]
    for field in ("setupStartAt", "processStartAt", "startAt", "endAt",
                  "startAtMinutes", "endAtMinutes", "changeoverMinutes",
                  "frozen", "affected"):
        assert field in op
    assert op["startAtMinutes"] <= op["processStartAtMinutes"] <= op["endAtMinutes"]
    assert r["meta"]["algorithmVersion"] == "event-adaptive-hga-1.0.0"
