from app.models import SolveRequest
from app.solver import solve
from tests.conftest import tiny_request


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


def test_hard_lock_unchanged_full_reschedule():
    base = _baseline()
    old_plan = _old_plan(base)
    locked = old_plan[0]
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[{
            "operationId": locked["operationId"],
            "lockType": "completed",
            "machineId": locked["machineId"],
            "startAtMinutes": locked["startAtMinutes"],
            "endAtMinutes": locked["endAtMinutes"],
            "changeoverMinutes": locked["changeoverMinutes"],
        }],
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    new = _by_id(resp)[locked["operationId"]]
    assert new["machineId"] == locked["machineId"]
    assert new["startAtMinutes"] == locked["startAtMinutes"]
    assert new["endAtMinutes"] == locked["endAtMinutes"]
    assert new["frozen"] is True
    assert "deltaPlan" in resp["kpi"]


def test_local_reschedule_keeps_unaffected_ops():
    base = _baseline()
    old_plan = _old_plan(base)
    affected = ["B1-10"]
    req = tiny_request(
        mode="LOCAL_RESCHEDULE",
        oldPlan=old_plan,
        affectedOperationIds=affected,
        lockings=[],
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    old_by_id = {op["operationId"]: op for op in old_plan}
    for op in resp["operations"]:
        if op["operationId"] in affected:
            continue
        old = old_by_id[op["operationId"]]
        assert op["machineId"] == old["machineId"]
        assert op["startAtMinutes"] == old["startAtMinutes"]


def test_reschedule_missing_old_plan_infeasible():
    req = tiny_request(mode="FULL_RESCHEDULE")
    resp = solve(SolveRequest(**req))
    assert resp["status"] == "INFEASIBLE"
    assert resp["resultStatus"] == "INFEASIBLE"
    rules = [c["rule"] for c in resp["constraintCheck"]["conflicts"]]
    assert "MISSING_OLD_PLAN" in rules
