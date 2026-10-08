from app.instance import build_problem
from app.kpi import compute_metrics
from app.models import SolveRequest
from tests.conftest import make_schedule

KPI_ORDERS = [
    {"orderId": "A1", "productFamily": "F1", "quantity": 10,
     "arrivalMinutes": 0, "dueMinutes": 100, "priority": 3,
     "operations": [
         {"operationId": "A1-10", "seqNo": 10,
          "candidates": [{"machineId": "M1", "setupMinutes": 5, "processMinutes": 20}]},
         {"operationId": "A1-20", "seqNo": 20,
          "candidates": [{"machineId": "M1", "setupMinutes": 5, "processMinutes": 15}]},
     ]},
    {"orderId": "B1", "productFamily": "F2", "quantity": 5,
     "arrivalMinutes": 0, "dueMinutes": 20, "priority": 2,
     "operations": [
         {"operationId": "B1-10", "seqNo": 10,
          "candidates": [{"machineId": "M2", "setupMinutes": 5, "processMinutes": 25}]},
     ]},
]

KPI_MACHINES = [
    {"machineId": "M1", "workCenterId": "WC1", "productFamilies": ["F1"],
     "availableIntervals": [[0, 600]]},
    {"machineId": "M2", "workCenterId": "WC1", "productFamilies": ["F2"],
     "availableIntervals": [[0, 600]]},
]


def _request(mode, orders, old_plan=None, affected=None):
    return {
        "mode": mode,
        "simulationStartAt": "2026-09-16T08:00:00+08:00",
        "machines": KPI_MACHINES if orders is KPI_ORDERS else DELTA_MACHINES,
        "orders": orders,
        "oldPlan": old_plan,
        "affectedOperationIds": affected,
        "changeoverDefault": 10,
        "objectiveWeights": {"makespan": 0.4, "weightedTardiness": 0.4,
                             "loadImbalance": 0.2},
        "algorithm": {"populationSize": 10, "maxGenerations": 5,
                      "timeLimitSeconds": 10, "randomSeed": 1},
    }


def test_kpi_cmax_tardiness_utilization():
    req = SolveRequest(**_request("BASELINE", KPI_ORDERS))
    problem = build_problem(req, [])
    plan = {
        "A1-10": ("M1", 0, 25, 0),
        "A1-20": ("M1", 25, 45, 0),
        "B1-10": ("M2", 0, 30, 0),
    }
    metrics = compute_metrics(problem, make_schedule(problem, plan))
    assert metrics["cmax"] == 45
    # B1: C=30, due=20, T=10, priority weight 2 -> 20
    assert metrics["tWeighted"] == 20
    assert metrics["nTardy"] == 1
    assert abs(metrics["utilization"]["M1"] - 45 / 600) < 1e-9
    assert abs(metrics["utilization"]["M2"] - 30 / 600) < 1e-9
    # mean = 0.0625, both deviations 0.0125
    assert abs(metrics["loadImbalance"] - 0.0125) < 1e-9


DELTA_MACHINES = [
    {"machineId": "M1", "workCenterId": "WC1", "productFamilies": ["F1", "F2"],
     "availableIntervals": [[0, 600]]},
    {"machineId": "M2", "workCenterId": "WC1", "productFamilies": ["F1", "F2"],
     "availableIntervals": [[0, 600]]},
]

DELTA_ORDERS = [
    {"orderId": "A1", "productFamily": "F1", "quantity": 10,
     "arrivalMinutes": 0, "dueMinutes": 500, "priority": 1,
     "operations": [
         {"operationId": "A1-10", "seqNo": 10,
          "candidates": [{"machineId": "M1", "setupMinutes": 5, "processMinutes": 20}]},
         {"operationId": "A1-20", "seqNo": 20,
          "candidates": [{"machineId": "M1", "setupMinutes": 5, "processMinutes": 15}]},
     ]},
    {"orderId": "B1", "productFamily": "F2", "quantity": 5,
     "arrivalMinutes": 0, "dueMinutes": 500, "priority": 1,
     "operations": [
         {"operationId": "B1-10", "seqNo": 10,
          "candidates": [{"machineId": "M1", "setupMinutes": 5, "processMinutes": 25},
                         {"machineId": "M2", "setupMinutes": 5, "processMinutes": 25}]},
     ]},
    {"orderId": "C1", "productFamily": "F1", "quantity": 8,
     "arrivalMinutes": 0, "dueMinutes": 500, "priority": 1,
     "operations": [
         {"operationId": "C1-10", "seqNo": 10,
          "candidates": [{"machineId": "M1", "setupMinutes": 5, "processMinutes": 10}]},
     ]},
]

OLD_PLAN = [
    {"operationId": "A1-10", "machineId": "M1", "startAtMinutes": 0, "endAtMinutes": 25},
    {"operationId": "A1-20", "machineId": "M1", "startAtMinutes": 25, "endAtMinutes": 45},
    {"operationId": "C1-10", "machineId": "M1", "startAtMinutes": 45, "endAtMinutes": 60},
    {"operationId": "B1-10", "machineId": "M2", "startAtMinutes": 0, "endAtMinutes": 30},
]


def _delta_problem_and_metrics(new_plan):
    req = SolveRequest(**_request("FULL_RESCHEDULE", DELTA_ORDERS, old_plan=OLD_PLAN))
    problem = build_problem(req, [])
    assert problem is not None
    metrics = compute_metrics(problem, make_schedule(problem, new_plan))
    return metrics["delta"]


def test_delta_plan_shift_and_sequence():
    # A1-20 shifted 25->40; C1-10 shifted 45->25 and now precedes A1-20
    new_plan = {
        "A1-10": ("M1", 0, 25, 0),
        "C1-10": ("M1", 25, 40, 0),
        "A1-20": ("M1", 40, 60, 0),
        "B1-10": ("M2", 0, 30, 0),
    }
    delta = _delta_problem_and_metrics(new_plan)
    assert abs(delta["startTimeShiftRate"] - 0.5) < 1e-9        # 2/4 shifted
    assert abs(delta["machineChangeRate"] - 0.0) < 1e-9
    # one inverted pair (A1-20, C1-10) out of 3 same-machine pairs on M1
    assert abs(delta["sequenceChangeRate"] - 1.0 / 3.0) < 1e-9
    expected = 0.5 * 0.5 + 0.3 * 0.0 + 0.2 * (1.0 / 3.0)
    assert abs(delta["deltaPlan"] - expected) < 1e-9
    assert delta["nMachineChange"] == 0


def test_delta_plan_machine_change():
    # additionally B1-10 moves M2 -> M1 and shifts 0 -> 60
    new_plan = {
        "A1-10": ("M1", 0, 25, 0),
        "C1-10": ("M1", 25, 40, 0),
        "A1-20": ("M1", 40, 60, 0),
        "B1-10": ("M1", 60, 90, 0),
    }
    delta = _delta_problem_and_metrics(new_plan)
    assert abs(delta["startTimeShiftRate"] - 0.75) < 1e-9       # 3/4 shifted
    assert abs(delta["machineChangeRate"] - 0.25) < 1e-9        # 1/4 changed
    assert delta["nMachineChange"] == 1
    expected = 0.5 * 0.75 + 0.3 * 0.25 + 0.2 * (1.0 / 3.0)
    assert abs(delta["deltaPlan"] - expected) < 1e-9


# ---- compute_delta sequence-rate differential test -------------------------
# Oracle below is the original O(n^2) pair enumeration, kept here as the
# reference for the optimized implementation in kpi.compute_delta.

import random as _random

from app.kpi import compute_delta


def _oracle_seq_rate(problem, placements):
    non_new = [op for op in problem.ops
               if not op.is_new and op.operation_id in problem.old_plan]
    old_by_m = {}
    new_by_m = {}
    for op in non_new:
        old_machine = problem.old_plan[op.operation_id][0]
        new_machine = placements[op.index][0]
        old_by_m.setdefault(old_machine, set()).add(op.operation_id)
        new_by_m.setdefault(new_machine, set()).add(op.operation_id)
    total = 0
    changed = 0
    for m in sorted(old_by_m):
        common = sorted(old_by_m[m] & new_by_m.get(m, set()))
        for x in range(len(common)):
            for y in range(x + 1, len(common)):
                a_id, b_id = common[x], common[y]
                oa = problem.old_plan[a_id][1]
                ob = problem.old_plan[b_id][1]
                na = placements[problem.op_index[a_id]][1]
                nb = placements[problem.op_index[b_id]][1]
                if oa == ob or na == nb:
                    continue
                total += 1
                if (oa > ob) != (na > nb):
                    changed += 1
    return changed / total if total else 0.0


def test_sequence_change_rate_matches_pair_enumeration():
    rng = _random.Random(20261008)
    machine_ids = ["M1", "M2", "M3"]
    machines = [{"machineId": m, "workCenterId": "WC1",
                 "productFamilies": ["F1", "F2"],
                 "availableIntervals": [[0, 10000]]} for m in machine_ids]
    for _ in range(40):
        # random instance: 2-5 orders x 1-3 ops, random old plan with ties
        orders = []
        old_plan = []
        for oi in range(rng.randint(2, 5)):
            ops = []
            for si in range(rng.randint(1, 3)):
                oid = "O%d-%d" % (oi, si)
                cands = [{"machineId": m, "setupMinutes": 0, "processMinutes": 10}
                         for m in rng.sample(machine_ids, rng.randint(1, 3))]
                ops.append({"operationId": oid, "seqNo": (si + 1) * 10,
                            "candidates": cands})
                if rng.random() < 0.85:  # leave some ops "new"
                    old_plan.append({
                        "operationId": oid,
                        "machineId": rng.choice(machine_ids),
                        # small value range -> frequent start-time ties
                        "startAtMinutes": rng.randrange(0, 8) * 10,
                        "endAtMinutes": 9999,
                    })
            orders.append({"orderId": "O%d" % oi, "productFamily": "F1",
                           "quantity": 1, "arrivalMinutes": 0,
                           "dueMinutes": 9999, "priority": 3,
                           "operations": ops})
        if not old_plan:
            continue
        req = SolveRequest(**{
            "mode": "FULL_RESCHEDULE",
            "simulationStartAt": "2026-09-16T08:00:00+08:00",
            "machines": machines,
            "orders": orders,
            "oldPlan": old_plan,
            "changeoverDefault": 0,
            "objectiveWeights": {},
            "algorithm": {"populationSize": 5, "maxGenerations": 1,
                          "timeLimitSeconds": 5, "randomSeed": 1},
        })
        problem = build_problem(req, [])
        assert problem is not None
        # random new placements with ties, machine changes included
        placements = [None] * len(problem.ops)
        for op in problem.ops:
            start = rng.randrange(0, 8) * 10
            placements[op.index] = (rng.choice(machine_ids), start,
                                    start + 10, 0)
        delta = compute_delta(problem, placements)
        expected = _oracle_seq_rate(problem, placements)
        assert abs(delta["sequenceChangeRate"] - expected) < 1e-12
