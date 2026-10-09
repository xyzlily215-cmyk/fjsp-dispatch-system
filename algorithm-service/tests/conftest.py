import os

import pytest


def pytest_collection_modifyitems(config, items):
    if os.environ.get("FJSP_RUN_SLOW") == "1":
        return
    skip_slow = pytest.mark.skip(
        reason="slow quality baseline; set FJSP_RUN_SLOW=1 to enable")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip_slow)


def tiny_request(**over):
    req = {
        "mode": "BASELINE",
        "simulationStartAt": "2026-09-16T08:00:00+08:00",
        "machines": [
            {"machineId": "M1", "workCenterId": "WC1",
             "productFamilies": ["F1", "F2"],
             "availableIntervals": [[0, 480]]},
            {"machineId": "M2", "workCenterId": "WC1",
             "productFamilies": ["F1", "F2"],
             "availableIntervals": [[0, 480]]},
        ],
        "orders": [
            {"orderId": "A1", "productFamily": "F1", "quantity": 10,
             "arrivalMinutes": 0, "dueMinutes": 100, "priority": 3,
             "operations": [
                 {"operationId": "A1-10", "seqNo": 10,
                  "candidates": [
                      {"machineId": "M1", "setupMinutes": 5, "processMinutes": 20},
                      {"machineId": "M2", "setupMinutes": 5, "processMinutes": 30}]},
                 {"operationId": "A1-20", "seqNo": 20,
                  "candidates": [
                      {"machineId": "M1", "setupMinutes": 5, "processMinutes": 15},
                      {"machineId": "M2", "setupMinutes": 5, "processMinutes": 10}]},
             ]},
            {"orderId": "B1", "productFamily": "F2", "quantity": 5,
             "arrivalMinutes": 0, "dueMinutes": 200, "priority": 1,
             "operations": [
                 {"operationId": "B1-10", "seqNo": 10,
                  "candidates": [
                      {"machineId": "M1", "setupMinutes": 5, "processMinutes": 40},
                      {"machineId": "M2", "setupMinutes": 5, "processMinutes": 25}]},
             ]},
        ],
        "changeoverDefault": 10,
        "changeoverMatrix": {"F1|F2": 15, "F2|F1": 12},
        "objectiveWeights": {"makespan": 0.4, "weightedTardiness": 0.4,
                             "loadImbalance": 0.2},
        "algorithm": {"populationSize": 20, "maxGenerations": 20,
                      "timeLimitSeconds": 30, "randomSeed": 7},
    }
    req.update(over)
    return req


def make_schedule(problem, plans):
    """plans: opId -> (machineId, startAt, endAt, changeover)"""
    from app.decoder import Schedule
    placements = [None] * len(problem.ops)
    timelines = {m: [] for m in problem.machine_ids}
    for op in problem.ops:
        machine, start, end, co = plans[op.operation_id]
        placements[op.index] = (machine, start, end, co)
        timelines[machine].append([start - co, end, op.index, start, co,
                                   op.family, op.completed, 0])
    for m in timelines:
        timelines[m].sort(key=lambda b: (b[0], b[1]))
    return Schedule(placements, timelines, [], 0, {})
