from typing import Dict, List, Optional, Tuple

from .conflicts import make_conflict
from .instance import MODE_LOCAL, Problem

_conflict = make_conflict


def validate_plan(problem: Problem,
                  placements: Dict[str, Tuple[str, int, int, int]]) -> List[dict]:
    """Full constraint check of a complete plan.

    placements: operationId -> (machineId, startAt, endAt, changeoverMinutes)
    Returns a list of conflict dicts; empty means passed.
    """
    conflicts: List[dict] = []

    # ---- coverage / candidate machine ----
    for op in problem.ops:
        pl = placements.get(op.operation_id)
        if pl is None:
            conflicts.append(_conflict(
                "MISSING_OPERATION", [op.operation_id], "ERROR",
                "方案缺少该工序的排程结果"))
            continue
        machine = pl[0]
        if machine not in problem.machines:
            conflicts.append(_conflict(
                "UNKNOWN_MACHINE", [op.operation_id, machine], "ERROR",
                "设备 %s 不在设备列表中" % machine))
            continue
        sp = op.cand_by_machine.get(machine)
        if sp is None:
            conflicts.append(_conflict(
                "NOT_CANDIDATE_MACHINE", [op.operation_id, machine], "ERROR",
                "设备 %s 不在工序 %s 的候选设备集合内" % (machine, op.operation_id)))
            continue
        setup, proc = sp
        if not op.hard_locked and pl[2] - pl[1] != setup + proc:
            conflicts.append(_conflict(
                "DURATION_MISMATCH", [op.operation_id], "ERROR",
                "endAt-startAt 应等于 setupMinutes+processMinutes（%d）" % (setup + proc)))
    if any(c["severity"] == "ERROR" and c["rule"] in
           ("MISSING_OPERATION", "UNKNOWN_MACHINE", "NOT_CANDIDATE_MACHINE")
           for c in conflicts):
        # subsequent checks need valid placements for every op
        missing = [c for c in conflicts if c["rule"] == "MISSING_OPERATION"]
        if missing:
            return conflicts

    # ---- release time & precedence ----
    for op in problem.ops:
        pl = placements.get(op.operation_id)
        if pl is None:
            continue
        if pl[1] < op.release:
            conflicts.append(_conflict(
                "RELEASE_VIOLATION", [op.operation_id], "ERROR",
                "工序开始时间 %d 早于订单释放时间 %d" % (pl[1], op.release)))
    for order in problem.orders:
        seq = order.op_indices
        for k in range(1, len(seq)):
            prev = problem.ops[seq[k - 1]]
            cur = problem.ops[seq[k]]
            p_prev = placements.get(prev.operation_id)
            p_cur = placements.get(cur.operation_id)
            if p_prev is None or p_cur is None:
                continue
            if p_prev[2] > p_cur[1]:
                conflicts.append(_conflict(
                    "PRECEDENCE_VIOLATION",
                    [prev.operation_id, cur.operation_id], "ERROR",
                    "工序 %s 开始时间早于前序工序 %s 的完成时间"
                    % (cur.operation_id, prev.operation_id)))

    # ---- per-machine: overlap / availability / changeover ----
    by_machine: Dict[str, List[Tuple[int, int, int, int, str]]] = {}
    for op in problem.ops:
        pl = placements.get(op.operation_id)
        if pl is None or pl[0] not in problem.machines:
            continue
        machine, start, end, co = pl
        by_machine.setdefault(machine, []).append((start - co, end, start, co, op.operation_id))

    for machine in sorted(by_machine):
        blocks = sorted(by_machine[machine])
        avail = problem.machines[machine].avail
        for i, (bs, be, st, co, oid) in enumerate(blocks):
            if i > 0:
                pbs, pbe, _pst, _pco, poid = blocks[i - 1]
                if bs < pbe:
                    conflicts.append(_conflict(
                        "MACHINE_OVERLAP", [machine, poid, oid], "ERROR",
                        "设备 %s 上工序 %s 与 %s 的占用区间（含换型）重叠"
                        % (machine, poid, oid)))
            ok = False
            for a, b in avail:
                if a <= bs and be <= b:
                    ok = True
                    break
            if not ok:
                conflicts.append(_conflict(
                    "AVAILABILITY_VIOLATION", [machine, oid], "ERROR",
                    "工序 %s 占用区间 [%d,%d) 未完整落在设备 %s 的任一可用区间内"
                    % (oid, bs, be, machine)))
        # changeover correctness for adjacent pairs
        for i in range(1, len(blocks)):
            _bs, _be, _st, _co, oid = blocks[i]
            prev_oid = blocks[i - 1][4]
            cur_op = problem.ops[problem.op_index[oid]]
            prev_op = problem.ops[problem.op_index[prev_oid]]
            expected = problem.changeover(
                prev_op.family, cur_op.family, prev_op.completed, cur_op.completed)
            recorded = blocks[i][3]
            if recorded != expected:
                conflicts.append(_conflict(
                    "CHANGEOVER_VIOLATION", [machine, prev_oid, oid], "ERROR",
                    "设备 %s 上 %s→%s 换型应为 %d 分钟，实际记录 %d 分钟"
                    % (machine, prev_oid, oid, expected, recorded)))

    # ---- hard locks ----
    for op in problem.ops:
        if not op.hard_locked:
            continue
        machine, start, end, co = op.fixed
        pl = placements.get(op.operation_id)
        if pl is None:
            continue
        if pl[0] != machine or pl[1] != start or pl[2] != end:
            conflicts.append(_conflict(
                "HARD_LOCK_VIOLATION", [op.operation_id], "ERROR",
                "硬锁定工序 %s 的设备或起止时间被改变" % op.operation_id))

    # ---- LOCAL mode equality constraints ----
    if problem.mode == MODE_LOCAL and problem.old_plan:
        for op in problem.ops:
            if op.hard_locked or op.is_new or op.operation_id in problem.affected:
                continue
            old = problem.old_plan.get(op.operation_id)
            pl = placements.get(op.operation_id)
            if old is None or pl is None:
                continue
            if pl[0] != old[0] or pl[1] != old[1]:
                conflicts.append(_conflict(
                    "LOCAL_FIX_VIOLATION", [op.operation_id], "ERROR",
                    "局部重调度中非影响集合工序 %s 的设备或开始时间被改变" % op.operation_id))

    return conflicts
