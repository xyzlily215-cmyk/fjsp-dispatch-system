from fastapi.testclient import TestClient

from app.api import app
from app.models import SolveRequest
from app.solver import solve
from conftest import tiny_request

client = TestClient(app)


def _baseline():
    req = SolveRequest(**tiny_request())
    resp = solve(req)
    assert resp["feasibleSolution"]
    return resp


def _old_plan(resp):
    return [{
        "operationId": op["operationId"],
        "machineId": op["machineId"],
        "startAtMinutes": op["startAtMinutes"],
        "endAtMinutes": op["endAtMinutes"],
        "changeoverMinutes": op["changeoverMinutes"],
    } for op in resp["operations"]]


def _by_id(resp):
    return {op["operationId"]: op for op in resp["operations"]}


def test_freeze_window_auto_freezes_old_plan_ops():
    base = _baseline()
    old_plan = _old_plan(base)
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[],
        freezeWindowMinutes=480,
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    old_by_id = {op["operationId"]: op for op in old_plan}
    for op in resp["operations"]:
        old = old_by_id[op["operationId"]]
        assert op["frozen"] is True
        assert op["machineId"] == old["machineId"]
        assert op["startAtMinutes"] == old["startAtMinutes"]
        assert op["endAtMinutes"] == old["endAtMinutes"]


def test_freeze_window_skips_affected_ops():
    base = _baseline()
    old_plan = _old_plan(base)
    affected = [old_plan[0]["operationId"]]
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[],
        affectedOperationIds=affected,
        freezeWindowMinutes=480,
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    new = _by_id(resp)
    assert new[affected[0]]["frozen"] is False
    old_by_id = {op["operationId"]: op for op in old_plan}
    for op in resp["operations"]:
        if op["operationId"] in affected:
            continue
        old = old_by_id[op["operationId"]]
        assert op["frozen"] is True
        assert op["machineId"] == old["machineId"]
        assert op["startAtMinutes"] == old["startAtMinutes"]


def test_freeze_window_inconsistent_locking_conflict():
    base = _baseline()
    old_plan = _old_plan(base)
    locked = old_plan[0]
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[{
            "operationId": locked["operationId"],
            "lockType": "frozen",
            "machineId": locked["machineId"],
            "startAtMinutes": locked["startAtMinutes"] + 10,
            "endAtMinutes": locked["endAtMinutes"] + 10,
            "changeoverMinutes": locked["changeoverMinutes"],
        }],
        freezeWindowMinutes=480,
    )
    resp = solve(SolveRequest(**req))
    assert resp["status"] == "INFEASIBLE"
    rules = [c["rule"] for c in resp["constraintCheck"]["conflicts"]]
    assert "LOCKING_INCONSISTENT" in rules


def test_no_freeze_window_no_auto_freeze():
    base = _baseline()
    old_plan = _old_plan(base)
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[],
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    for op in resp["operations"]:
        assert op["frozen"] is False


def _validate_request(old_plan, plan_ops, **over):
    vreq = tiny_request()
    vreq.pop("objectiveWeights")
    vreq.pop("algorithm")
    vreq.pop("mode")
    vreq["oldPlan"] = old_plan
    vreq["operations"] = plan_ops
    vreq.update(over)
    return vreq


def test_validate_inherits_freeze_window():
    base = _baseline()
    old_plan = _old_plan(base)
    moved = old_plan[1]
    plan_ops = []
    for op in old_plan:
        p = dict(op)
        if op["operationId"] == moved["operationId"]:
            p["startAtMinutes"] = op["startAtMinutes"] + 100
            p["endAtMinutes"] = op["endAtMinutes"] + 100
        plan_ops.append(p)

    vreq = _validate_request(old_plan, plan_ops, freezeWindowMinutes=480)
    rv = client.post("/validate", json=vreq)
    assert rv.status_code == 200
    vbody = rv.json()
    assert vbody["passed"] is False
    rules = [c["rule"] for c in vbody["conflicts"]]
    assert "HARD_LOCK_VIOLATION" in rules

    # without freezeWindowMinutes the same placement is not lock-checked
    vreq2 = _validate_request(old_plan, plan_ops)
    rv2 = client.post("/validate", json=vreq2)
    assert rv2.status_code == 200
    rules2 = [c["rule"] for c in rv2.json()["conflicts"]]
    assert "HARD_LOCK_VIOLATION" not in rules2
