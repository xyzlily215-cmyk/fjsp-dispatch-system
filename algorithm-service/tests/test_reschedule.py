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
    """迟开工不是加工进度：锚定实际开工后仍需完整计划时长。"""
    base = _baseline()
    old_plan = _old_plan(base)
    locked = old_plan[0]
    planned_proc = locked["endAtMinutes"] - locked["startAtMinutes"]
    # 即便实际开工晚于原计划完工，也不能把迟到时间当作已经加工。
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
    assert new["endAtMinutes"] == actual_start + planned_proc


def test_delayed_start_does_not_release_machine_or_successor_early():
    req = tiny_request(
        mode="FULL_RESCHEDULE",
        machines=[{"machineId": "M1", "availableIntervals": [[0, 600]]}],
        orders=[{"orderId": "O1", "productFamily": "F1", "quantity": 1,
                 "arrivalMinutes": 0, "dueMinutes": 500, "priority": 1,
                 "operations": [
                     {"operationId": "running", "seqNo": 1, "candidates": [
                         {"machineId": "M1", "setupMinutes": 0, "processMinutes": 60}]},
                     {"operationId": "next", "seqNo": 2, "candidates": [
                         {"machineId": "M1", "setupMinutes": 0, "processMinutes": 30}]}]}],
        oldPlan=[{"operationId": "running", "machineId": "M1",
                  "startAtMinutes": 60, "endAtMinutes": 120}],
        lockings=[{"operationId": "running", "lockType": "in_progress",
                   "machineId": "M1", "startAtMinutes": 60, "endAtMinutes": 120,
                   "actualStartAtMinutes": 120}],
    )
    result = solve(SolveRequest(**req))
    assert result["feasibleSolution"], result["constraintCheck"]
    operations = _by_id(result)
    assert operations["running"]["endAtMinutes"] == 180
    assert operations["next"]["startAtMinutes"] >= 180


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
