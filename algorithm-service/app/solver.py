import time
from typing import List

from . import ALGORITHM_VERSION
from .ga import HybridGA, resolve_objective_weights
from .instance import MODE_BASELINE, build_problem
from .kpi import build_kpi
from .models import SolveRequest
from .timeutil import minutes_to_iso
from .validator import validate_plan


def _infeasible_response(conflicts, elapsed_ms, seed):
    return {
        "status": "INFEASIBLE",
        "resultStatus": "INFEASIBLE",
        "feasibleSolution": False,
        "operations": [],
        "kpi": None,
        "constraintCheck": {"passed": False, "conflicts": conflicts},
        "meta": {
            "generations": 0,
            "elapsedMs": elapsed_ms,
            "seed": seed,
            "algorithmVersion": ALGORITHM_VERSION,
        },
    }


def solve(req: SolveRequest) -> dict:
    t0 = time.monotonic()
    seed = req.algorithm.randomSeed
    conflicts: List[dict] = []
    problem = build_problem(req, conflicts)
    errors = [c for c in conflicts if c["severity"] == "ERROR"]
    if problem is None or errors:
        return _infeasible_response(conflicts, int((time.monotonic() - t0) * 1000), seed)

    weights = resolve_objective_weights(problem.mode, req.objectiveWeights)
    ga = HybridGA(problem, req.algorithm, weights)
    result = ga.run()
    schedule = result.best_schedule
    metrics = result.best_metrics

    if schedule.penalty_ops:
        conflict_list = [{
            "rule": "NO_FEASIBLE_WINDOW",
            "objects": sorted(schedule.penalty_ops),
            "severity": "ERROR",
            "suggestion": "以下工序无法在候选设备的可用区间内完成排程，请检查可用区间或候选设备",
        }]
        resp = _infeasible_response(conflict_list, int((time.monotonic() - t0) * 1000), seed)
        resp["meta"]["generations"] = result.generations
        return resp

    placements = {
        op.operation_id: schedule.placements[op.index] for op in problem.ops
    }
    check_conflicts = validate_plan(problem, placements)
    passed = not any(c["severity"] == "ERROR" for c in check_conflicts)

    operations = []
    for order in problem.orders:
        for idx in order.op_indices:
            op = problem.ops[idx]
            machine, start, end, co = placements[op.operation_id]
            setup = next(s for m, s, _p in op.candidates if m == machine)
            process_start = start + setup
            affected = True
            if problem.mode != MODE_BASELINE:
                affected = op.operation_id in problem.affected or op.is_new
            reason = None
            if not op.is_new and op.soft_locked:
                old = problem.old_plan.get(op.operation_id)
                if old and (old[0] != machine or old[1] != start):
                    reason = "SOFT_LOCK_ADJUSTED"
            if reason is None and problem.mode != MODE_BASELINE and op.is_new:
                reason = "NEW_OPERATION"
            entry = {
                "operationId": op.operation_id,
                "machineId": machine,
                "setupStartAt": minutes_to_iso(start, problem.sim_start),
                "setupStartAtMinutes": start,
                "processStartAt": minutes_to_iso(process_start, problem.sim_start),
                "processStartAtMinutes": process_start,
                "startAt": minutes_to_iso(start, problem.sim_start),
                "startAtMinutes": start,
                "endAt": minutes_to_iso(end, problem.sim_start),
                "endAtMinutes": end,
                "changeoverMinutes": co,
                "frozen": op.hard_locked,
                "affected": affected,
            }
            if reason is not None:
                entry["reasonCode"] = reason
            operations.append(entry)

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    status = "TIME_LIMIT" if result.timed_out else "SUCCESS"
    return {
        "status": status,
        "resultStatus": "FEASIBLE" if passed else "INFEASIBLE",
        "feasibleSolution": passed,
        "operations": operations,
        "kpi": build_kpi(problem, metrics),
        "constraintCheck": {"passed": passed, "conflicts": check_conflicts},
        "meta": {
            "generations": result.generations,
            "elapsedMs": elapsed_ms,
            "seed": seed,
            "algorithmVersion": ALGORITHM_VERSION,
        },
    }
