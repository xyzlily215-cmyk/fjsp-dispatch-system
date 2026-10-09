from app.models import SolveRequest
from app.solver import solve
from conftest import tiny_request


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


def test_in_progress_lock_anchors_to_actual_start():
    """in_progress 锁定带 actualStartAtMinutes：窗口锚定实际开工，结束按剩余工时顺延。"""
    base = _baseline()
    old_plan = _old_plan(base)
    locked = old_plan[0]
    planned_proc = locked["endAtMinutes"] - locked["startAtMinutes"]
    # 实际开工晚于计划完工：elapsed 超过计划加工时长 -> 至少保留 1 分钟
    actual_start = locked["endAtMinutes"] + 15
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[{
            "operationId": locked["operationId"],
            "lockType": "in_progress",
            "machineId": locked["machineId"],
            "startAtMinutes": locked["startAtMinutes"],
            "endAtMinutes": locked["endAtMinutes"],
            "actualStartAtMinutes": actual_start,
            "changeoverMinutes": locked["changeoverMinutes"],
        }],
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    new = _by_id(resp)[locked["operationId"]]
    assert new["machineId"] == locked["machineId"]
    assert new["startAtMinutes"] == actual_start
    assert new["endAtMinutes"] == actual_start + 1


def test_in_progress_lock_on_time_keeps_duration():
    """按时开工：elapsed≈0，窗口保持计划加工时长。"""
    base = _baseline()
    old_plan = _old_plan(base)
    locked = old_plan[0]
    planned_proc = locked["endAtMinutes"] - locked["startAtMinutes"]
    actual_start = locked["startAtMinutes"]
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[{
            "operationId": locked["operationId"],
            "lockType": "in_progress",
            "machineId": locked["machineId"],
            "startAtMinutes": locked["startAtMinutes"],
            "endAtMinutes": locked["endAtMinutes"],
            "actualStartAtMinutes": actual_start,
            "changeoverMinutes": locked["changeoverMinutes"],
        }],
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    new = _by_id(resp)[locked["operationId"]]
    assert new["startAtMinutes"] == actual_start
    assert new["endAtMinutes"] == actual_start + planned_proc


def test_in_progress_lock_without_actual_start_unchanged():
    """不带 actualStartAtMinutes 时保持旧语义：窗口等于锁定请求值。"""
    base = _baseline()
    old_plan = _old_plan(base)
    locked = old_plan[0]
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        oldPlan=old_plan,
        lockings=[{
            "operationId": locked["operationId"],
            "lockType": "in_progress",
            "machineId": locked["machineId"],
            "startAtMinutes": locked["startAtMinutes"],
            "endAtMinutes": locked["endAtMinutes"],
            "changeoverMinutes": locked["changeoverMinutes"],
        }],
    )
    resp = solve(SolveRequest(**req))
    assert resp["feasibleSolution"], resp["constraintCheck"]
    new = _by_id(resp)[locked["operationId"]]
    assert new["startAtMinutes"] == locked["startAtMinutes"]
    assert new["endAtMinutes"] == locked["endAtMinutes"]
