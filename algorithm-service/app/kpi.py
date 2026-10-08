from bisect import bisect_left, bisect_right, insort
from typing import Dict, List, Tuple

from .decoder import BCMP, BCO, BFAM, BS, Schedule
from .instance import MODE_BASELINE, Problem


def norm(x, base):
    b = abs(base)
    if b < 1:
        b = 1
    return x / b


def order_completion(problem: Problem, placements) -> Dict[str, int]:
    comp = {}
    for order in problem.orders:
        c = 0
        for i in order.op_indices:
            end = placements[i][2]
            if end > c:
                c = end
        comp[order.order_id] = c
    return comp


def compute_delta(problem: Problem, placements) -> Dict[str, float]:
    zero = {
        "startTimeShiftRate": 0.0,
        "machineChangeRate": 0.0,
        "sequenceChangeRate": 0.0,
        "deltaPlan": 0.0,
        "nMachineChange": 0,
    }
    if problem.mode == MODE_BASELINE or not problem.old_plan:
        return zero

    adjustable_old = [
        op for op in problem.ops
        if not op.is_new and not op.hard_locked
        and (problem.mode != "LOCAL_RESCHEDULE" or op.operation_id in problem.affected)
    ]
    # sequence change uses all non-new ops (pairs with locked ops can still change order)
    non_new = [op for op in problem.ops if not op.is_new and op.operation_id in problem.old_plan]

    d = len(adjustable_old)
    if d == 0:
        shift_rate = 0.0
        machine_rate = 0.0
        n_machine_change = 0
    else:
        shift = 0
        mchg = 0
        for op in adjustable_old:
            old_machine, old_start, _e, _c = problem.old_plan[op.operation_id]
            pl = placements[op.index]
            if pl[1] != old_start:
                shift += 1
            if pl[0] != old_machine:
                mchg += 1
        shift_rate = shift / d
        machine_rate = mchg / d
        n_machine_change = mchg

    # Sequence-change rate over unordered same-machine pairs: a pair counts
    # towards `total` only when both old and new starts are strict (no tie),
    # and towards `changed` when the relative order flipped. The old-plan
    # order is static, so we walk ops grouped by old start (precomputed and
    # sorted at Problem build time) and maintain a sorted list of the new
    # starts already seen: for a new start na, earlier ops with na' > na are
    # inversions, and na' == na are tie-excluded. O(n log n)-ish per machine
    # instead of O(n^2) pair enumeration per chromosome.
    new_start_by_m: Dict[str, Dict[str, int]] = {}
    for op in non_new:
        pl = placements[op.index]
        new_start_by_m.setdefault(pl[0], {})[op.operation_id] = pl[1]
    total = 0
    changed = 0
    for m, old_seq in problem.old_seq_by_machine.items():
        new_map = new_start_by_m.get(m)
        if not new_map:
            continue
        prev_starts: List[int] = []  # sorted new starts of earlier old-start groups
        i = 0
        n = len(old_seq)
        while i < n:
            o_start = old_seq[i][1]
            group = []
            while i < n and old_seq[i][1] == o_start:
                na = new_map.get(old_seq[i][0])
                if na is not None:
                    group.append(na)
                i += 1
            for na in group:
                le = bisect_right(prev_starts, na)
                eq = le - bisect_left(prev_starts, na)
                total += len(prev_starts) - eq
                changed += len(prev_starts) - le
            for na in group:
                insort(prev_starts, na)
    seq_rate = changed / total if total else 0.0

    dw = problem.delta_weights
    delta = (dw["startTimeShift"] * shift_rate
             + dw["machineChange"] * machine_rate
             + dw["sequenceChange"] * seq_rate)
    return {
        "startTimeShiftRate": shift_rate,
        "machineChangeRate": machine_rate,
        "sequenceChangeRate": seq_rate,
        "deltaPlan": delta,
        "nMachineChange": n_machine_change,
    }


def compute_metrics(problem: Problem, schedule: Schedule) -> Dict:
    placements = schedule.placements
    comp = order_completion(problem, placements)
    cmax = 0
    t_weighted = 0
    n_tardy = 0
    for order in problem.orders:
        c = comp[order.order_id]
        if c > cmax:
            cmax = c
        t = c - order.due
        if t > 0:
            t_weighted += order.weight * t
            n_tardy += 1

    occ = dict((m, 0) for m in problem.machine_ids)
    for m in problem.machine_ids:
        total = 0
        for blk in schedule.timelines[m]:
            total += blk[1] - blk[BS]  # (endAt) - (startAt - changeover)
        occ[m] = total
    utilization = {}
    us = []
    for m in problem.machine_ids:
        avail_min = problem.machines[m].avail_minutes
        u = (occ[m] / avail_min) if avail_min > 0 else 0.0
        utilization[m] = u
        if avail_min > 0:
            us.append(u)
    if us:
        mean_u = sum(us) / len(us)
        load_imbalance = sum(abs(u - mean_u) for u in us) / len(us)
    else:
        load_imbalance = 0.0

    delta = compute_delta(problem, placements)
    return {
        "cmax": cmax,
        "tWeighted": t_weighted,
        "nTardy": n_tardy,
        "utilization": utilization,
        "loadImbalance": load_imbalance,
        "delta": delta,
        "nMachineChange": delta["nMachineChange"],
    }


def build_kpi(problem: Problem, metrics: Dict) -> Dict:
    kpi = {
        "cMaxMinutes": metrics["cmax"],
        "weightedTardinessMinutes": metrics["tWeighted"],
        "nTardy": metrics["nTardy"],
        "utilizationByMachine": dict(
            (m, round(u, 4)) for m, u in metrics["utilization"].items()
        ),
        "loadImbalance": round(metrics["loadImbalance"], 6),
    }
    if problem.mode != MODE_BASELINE:
        d = metrics["delta"]
        kpi["deltaPlan"] = {
            "startTimeShiftRate": round(d["startTimeShiftRate"], 6),
            "machineChangeRate": round(d["machineChangeRate"], 6),
            "sequenceChangeRate": round(d["sequenceChangeRate"], 6),
            "deltaPlan": round(d["deltaPlan"], 6),
            "nMachineChange": d["nMachineChange"],
            "weights": dict(problem.delta_weights),
        }
    return kpi
