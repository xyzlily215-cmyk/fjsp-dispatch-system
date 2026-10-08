import copy

from app.decoder import decode
from app.instance import build_problem
from app.models import SolveRequest
from tests.conftest import tiny_request


def _shrinking_local_problem():
    # LOCAL_RESCHEDULE 下 B1-10 是 BFIX=1 的等值固定块；其旧计划预留换型 15 分钟，
    # 但解码后它的时间线前驱 A1-10 与它同族（F2），实际换型应为 0 ——
    # 归一化必然缩水该块的 BCO，正是历史上就地写回 problem.fixed_blocks 的路径
    req = tiny_request(
        mode="LOCAL_RESCHEDULE",
        machines=[
            {"machineId": "M1", "availableIntervals": [[0, 480]]},
            {"machineId": "M2", "availableIntervals": [[0, 480]]},
        ],
        orders=[
            {"orderId": "A1", "productFamily": "F2", "quantity": 1,
             "arrivalMinutes": 0, "dueMinutes": 300, "priority": 3,
             "operations": [
                 {"operationId": "A1-10", "seqNo": 10,
                  "candidates": [
                      {"machineId": "M1", "setupMinutes": 5, "processMinutes": 20},
                      {"machineId": "M2", "setupMinutes": 5, "processMinutes": 25}]},
             ]},
            {"orderId": "B1", "productFamily": "F2", "quantity": 1,
             "arrivalMinutes": 0, "dueMinutes": 300, "priority": 3,
             "operations": [
                 {"operationId": "B1-10", "seqNo": 10,
                  "candidates": [
                      {"machineId": "M1", "setupMinutes": 5, "processMinutes": 20}]},
             ]},
        ],
        oldPlan=[{"operationId": "B1-10", "machineId": "M1",
                  "startAtMinutes": 100, "endAtMinutes": 120,
                  "changeoverMinutes": 15}],
        affectedOperationIds=["A1-10"],
        lockings=[],
    )
    conflicts = []
    problem = build_problem(SolveRequest(**req), conflicts)
    assert problem is not None, conflicts
    return problem


def test_decode_does_not_mutate_fixed_blocks():
    """GA 在一次求解内复用同一 problem 反复 decode：解码末尾的换型归一化只允许
    改自己的时间线副本，不能写回 problem.fixed_blocks，否则被缩水的 BCO 会污染
    后续染色体评估中 _try_slot 对 BFIX=1 块的判断。"""
    problem = _shrinking_local_problem()
    assert problem.fixed_blocks["M1"], "前置条件：存在等值固定块"
    before = copy.deepcopy(problem.fixed_blocks)

    # 两个不同染色体：A1-10 分别落在 M1（成为固定块前驱，触发归一化缩水）和 M2
    decode(problem, [0], [0])
    assert problem.fixed_blocks == before
    decode(problem, [0], [1])
    assert problem.fixed_blocks == before

    # 同一染色体重复解码结果一致：无污染时 decode 是确定的
    s1 = decode(problem, [0], [0])
    s1b = decode(problem, [0], [0])
    assert s1b.placements == s1.placements
