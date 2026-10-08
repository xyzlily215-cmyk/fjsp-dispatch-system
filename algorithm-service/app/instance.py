from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Union

from .conflicts import make_conflict
from .models import (
    HARD_LOCK_TYPES,
    MODE_BASELINE,
    MODE_FULL,
    MODE_LOCAL,
    SolveRequest,
    ValidateRequest,
)
from .timeutil import iso_to_minutes

PRIORITY_WEIGHTS = {1: 1, 2: 2, 3: 3, 4: 5, 5: 8}

INF = 10 ** 12


@dataclass
class MachineRec:
    machine_id: str
    work_center_id: str
    product_families: List[str]
    avail: List[Tuple[int, int]]  # merged, sorted
    avail_minutes: int


@dataclass
class OpRec:
    index: int
    operation_id: str
    order_id: str
    order_idx: int
    seq_no: int
    family: str
    release: int
    due: int
    weight: int
    candidates: List[Tuple[str, int, int]]  # (machineId, setupMinutes, processMinutes)
    cand_by_machine: Dict[str, Tuple[int, int]] = field(default_factory=dict)  # machineId -> (setup, process)
    completed: bool = False
    hard_locked: bool = False
    soft_locked: bool = False
    fixed: Optional[Tuple[str, int, int, int]] = None  # (machine, startAt, endAt, changeover)
    adjustable: bool = True
    is_new: bool = True
    ms_pos: int = -1  # position in the MS chromosome (adjustable ops only)


@dataclass
class OrderRec:
    order_id: str
    order_idx: int
    family: str
    arrival: int
    due: int
    weight: int
    op_indices: List[int] = field(default_factory=list)  # op indexes sorted by seqNo


@dataclass
class Problem:
    sim_start: datetime
    mode: str
    machines: Dict[str, MachineRec]
    machine_ids: List[str]
    ops: List[OpRec]
    op_index: Dict[str, int]
    orders: List[OrderRec]
    changeover_default: int
    changeover_matrix: Dict[str, int]
    old_plan: Dict[str, Tuple[str, int, int, int]]  # opId -> (machine, start, end, changeover)
    affected: set
    delta_weights: Dict[str, float]
    # derived
    adjustable_ops: List[OpRec] = field(default_factory=list)
    adjustable_by_order: List[List[OpRec]] = field(default_factory=list)
    prev_op: List[int] = field(default_factory=list)  # op index of order predecessor, -1 if none
    next_op: List[int] = field(default_factory=list)
    fixed_blocks: Dict[str, list] = field(default_factory=dict)  # machine -> [block]
    # machine -> [(opId, oldStart)] sorted by (oldStart, opId); static old-plan
    # ordering reused by every compute_delta call during the GA
    old_seq_by_machine: Dict[str, List[Tuple[str, int]]] = field(default_factory=dict)
    _co_cache: Dict[Tuple[str, str], int] = field(default_factory=dict)

    def changeover(self, fam_a, fam_b, completed_a, completed_b):
        if fam_a == fam_b:
            return 0
        if completed_a or completed_b:
            return 0
        # beyond the two short-circuits above completed_* are always False,
        # so the cache key is just the family pair
        key = (fam_a, fam_b)
        v = self._co_cache.get(key)
        if v is not None:
            return v
        m = self.changeover_matrix
        k = fam_a + "|" + fam_b
        if k in m:
            v = m[k]
        else:
            rk = fam_b + "|" + fam_a
            v = m.get(rk, self.changeover_default)
        self._co_cache[key] = v
        return v


def _resolve_minutes(minutes_val, iso_val, sim_start, field_name, op_id, conflicts):
    if minutes_val is not None:
        return minutes_val
    if iso_val is not None:
        if iso_val.tzinfo is None:
            conflicts.append(make_conflict(
                "E_VALIDATION", [op_id], "ERROR",
                "%s 必须带时区" % field_name))
            return None
        return iso_to_minutes(iso_val, sim_start)
    return None


def _merge_intervals(intervals):
    ivs = sorted((int(a), int(b)) for a, b in intervals)
    merged = []
    for a, b in ivs:
        if merged and a <= merged[-1][1]:
            if b > merged[-1][1]:
                merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return merged


def _build_machines(req):
    machines = {}
    for m in req.machines:
        merged = _merge_intervals(m.availableIntervals)
        machines[m.machineId] = MachineRec(
            machine_id=m.machineId,
            work_center_id=m.workCenterId,
            product_families=list(m.productFamilies),
            avail=merged,
            avail_minutes=sum(b - a for a, b in merged),
        )
    return machines, list(machines.keys())


def _build_orders(req, conflicts):
    ops = []
    op_index = {}
    orders = []
    for o_idx, o in enumerate(req.orders):
        order = OrderRec(
            order_id=o.orderId,
            order_idx=o_idx,
            family=o.productFamily,
            arrival=o.arrivalMinutes,
            due=o.dueMinutes,
            weight=PRIORITY_WEIGHTS[o.priority],
        )
        for sop in sorted(o.operations, key=lambda x: x.seqNo):
            cands = [(c.machineId, c.setupMinutes, c.processMinutes) for c in sop.candidates]
            rec = OpRec(
                index=len(ops),
                operation_id=sop.operationId,
                order_id=o.orderId,
                order_idx=o_idx,
                seq_no=sop.seqNo,
                family=o.productFamily,
                release=o.arrivalMinutes,
                due=o.dueMinutes,
                weight=PRIORITY_WEIGHTS[o.priority],
                candidates=cands,
                cand_by_machine={m: (s, p) for m, s, p in cands},
            )
            if sop.operationId in op_index:
                conflicts.append(make_conflict(
                    "DUPLICATE_OPERATION", [sop.operationId], "ERROR",
                    "工序编号重复，请检查输入"))
            op_index[sop.operationId] = rec.index
            order.op_indices.append(rec.index)
            ops.append(rec)
        orders.append(order)
    return ops, op_index, orders


def _resolve_old_plan(req, sim_start, conflicts):
    old_plan = {}
    for op_in in (req.oldPlan or []):
        start = _resolve_minutes(op_in.startAtMinutes, op_in.startAt, sim_start,
                                 "startAt", op_in.operationId, conflicts)
        end = _resolve_minutes(op_in.endAtMinutes, op_in.endAt, sim_start,
                               "endAt", op_in.operationId, conflicts)
        if start is None or end is None:
            conflicts.append(make_conflict(
                "E_VALIDATION", [op_in.operationId], "ERROR",
                "oldPlan 需要 startAt/endAt（ISO）或 startAtMinutes/endAtMinutes"))
            continue
        old_plan[op_in.operationId] = (op_in.machineId, start, end, op_in.changeoverMinutes)
    return old_plan


def _resolve_lockings(req, sim_start, conflicts):
    hard_locks = {}
    soft_locked_ids = set()
    for lk in (req.lockings or []):
        lt = lk.lockType
        if lk.softLocked:
            lt = "soft"
        if lt == "soft":
            soft_locked_ids.add(lk.operationId)
            continue
        if lt not in HARD_LOCK_TYPES:
            conflicts.append(make_conflict(
                "E_VALIDATION", [lk.operationId], "ERROR",
                "lockType 必须是 completed/in_progress/frozen/soft"))
            continue
        start = _resolve_minutes(lk.startAtMinutes, lk.startAt, sim_start,
                                 "startAt", lk.operationId, conflicts)
        end = _resolve_minutes(lk.endAtMinutes, lk.endAt, sim_start,
                               "endAt", lk.operationId, conflicts)
        if lk.machineId is None or start is None or end is None:
            conflicts.append(make_conflict(
                "E_VALIDATION", [lk.operationId], "ERROR",
                "硬锁定工序必须提供 machineId 与固定起止时间"))
            continue
        if lt == "in_progress" and lk.actualStartAtMinutes is not None:
            # 实际开工即事实：窗口锚定到 actualStart，结束时间按剩余工时顺延。
            # 剩余工时 = 计划加工时长 - 已进行时长；假设迟到反馈≈刚开工，elapsed 近似进度；
            # 超期仍在加工的至少保留 1 分钟余量。
            actual = lk.actualStartAtMinutes
            planned_proc = max(0, end - start)
            elapsed = max(0, actual - start)
            remaining = max(1, planned_proc - elapsed)
            start, end = actual, actual + remaining
        hard_locks[lk.operationId] = (lk.machineId, start, end, lk.changeoverMinutes, lt)
    return hard_locks, soft_locked_ids


def _apply_freeze_window(req, ops, old_plan, affected, hard_locks, conflicts):
    # freeze window: non-affected old-plan ops starting within
    # [simulationStartAt, simulationStartAt + freezeWindowMinutes) are frozen
    freeze_window = getattr(req, "freezeWindowMinutes", None)
    if freeze_window is None or not old_plan:
        return
    for op in ops:
        old = old_plan.get(op.operation_id)
        if old is None or op.operation_id in affected:
            continue
        machine, start, end, co = old
        if not (0 <= start < freeze_window):
            continue
        existing = hard_locks.get(op.operation_id)
        if existing is None:
            hard_locks[op.operation_id] = (machine, start, end, co, "frozen")
        elif existing[4] == "in_progress":
            # 执行中工序的窗口以 actualStart 锚定，允许与旧计划不同
            continue
        elif existing[0] != machine or existing[1] != start or existing[2] != end:
            conflicts.append(make_conflict(
                "LOCKING_INCONSISTENT", [op.operation_id], "ERROR",
                "冻结窗口内工序的硬锁定与 oldPlan 的设备/起止时间不一致"))


def _apply_lock_flags(ops, old_plan, hard_locks, soft_locked_ids):
    for op in ops:
        op.is_new = op.operation_id not in old_plan
        if op.operation_id in soft_locked_ids:
            op.soft_locked = True
        if op.operation_id in hard_locks:
            machine, start, end, co, lt = hard_locks[op.operation_id]
            op.hard_locked = True
            op.completed = (lt == "completed")
            op.fixed = (machine, start, end, co)


def _apply_local_fix(mode, ops, old_plan, affected, conflicts):
    # LOCAL mode: non-affected, non-hard-locked, non-new ops are equality-constrained
    if mode != MODE_LOCAL:
        return
    for op in ops:
        if op.hard_locked or op.is_new:
            continue
        if op.operation_id in affected:
            continue
        machine, start, _end, co = old_plan[op.operation_id]
        dur = _duration_on(op, machine)
        if dur is None:
            conflicts.append(make_conflict(
                "NOT_CANDIDATE_MACHINE", [op.operation_id, machine], "ERROR",
                "oldPlan 中的设备不在该工序候选设备集合内"))
            continue
        op.fixed = (machine, start, start + dur, co)


def _resolve_delta_weights(req):
    delta_weights = {"startTimeShift": 0.5, "machineChange": 0.3, "sequenceChange": 0.2}
    if getattr(req, "deltaPlanWeights", None):
        for k in delta_weights:
            if k in req.deltaPlanWeights:
                delta_weights[k] = float(req.deltaPlanWeights[k])
    return delta_weights


def _derive_structures(problem):
    ops = problem.ops
    problem.prev_op = [-1] * len(ops)
    problem.next_op = [-1] * len(ops)
    for order in problem.orders:
        seq = order.op_indices
        for k, idx in enumerate(seq):
            if k > 0:
                problem.prev_op[idx] = seq[k - 1]
            if k + 1 < len(seq):
                problem.next_op[idx] = seq[k + 1]

    problem.adjustable_ops = [op for op in ops if op.adjustable]
    problem.adjustable_by_order = [
        [ops[i] for i in order.op_indices if ops[i].adjustable] for order in problem.orders
    ]
    for pos, op in enumerate(problem.adjustable_ops):
        op.ms_pos = pos


def _build_fixed_blocks(problem, conflicts):
    # pre-placed fixed blocks: [blockStart, endAt, opIndex, startAt, changeover, family, completed, kind]
    # kind: 2 = hard locked (times + changeover immutable), 1 = LOCAL equality-fixed (startAt fixed, changeover may shrink)
    fixed_blocks = {m: [] for m in problem.machine_ids}
    for op in problem.ops:
        if op.fixed is None:
            continue
        machine, start, end, co = op.fixed
        if machine not in problem.machines:
            conflicts.append(make_conflict(
                "UNKNOWN_MACHINE", [op.operation_id, machine], "ERROR",
                "锁定/原计划的设备不在设备列表中"))
            continue
        kind = 2 if op.hard_locked else 1
        fixed_blocks[machine].append([start - co, end, op.index, start, co, op.family, op.completed, kind])
    for m in problem.machine_ids:
        fixed_blocks[m].sort(key=lambda b: (b[0], b[1]))
    problem.fixed_blocks = fixed_blocks


def build_problem(req: Union[SolveRequest, ValidateRequest],
                  conflicts: List[dict]) -> Optional[Problem]:
    """Build the internal problem from a SolveRequest or ValidateRequest.

    `conflicts` is an output list; pre-check violations are appended to it.
    Returns None when a structural error prevents problem construction.
    """
    sim_start = req.simulationStartAt
    machines, machine_ids = _build_machines(req)
    ops, op_index, orders = _build_orders(req, conflicts)

    if any(c["severity"] == "ERROR" for c in conflicts):
        return None

    mode = getattr(req, "mode", None) or MODE_BASELINE

    old_plan = _resolve_old_plan(req, sim_start, conflicts)
    affected = set(req.affectedOperationIds or [])

    if mode in (MODE_LOCAL, MODE_FULL) and not old_plan:
        conflicts.append(make_conflict(
            "MISSING_OLD_PLAN", [mode], "ERROR",
            "重调度模式必须提供 oldPlan"))
    if mode == MODE_LOCAL and req.affectedOperationIds is None:
        conflicts.append(make_conflict(
            "MISSING_AFFECTED_SET", [mode], "ERROR",
            "LOCAL_RESCHEDULE 必须提供 affectedOperationIds（可为空列表）"))

    hard_locks, soft_locked_ids = _resolve_lockings(req, sim_start, conflicts)

    if any(c["severity"] == "ERROR" for c in conflicts):
        return None

    _apply_freeze_window(req, ops, old_plan, affected, hard_locks, conflicts)

    if any(c["severity"] == "ERROR" for c in conflicts):
        return None

    _apply_lock_flags(ops, old_plan, hard_locks, soft_locked_ids)
    _apply_local_fix(mode, ops, old_plan, affected, conflicts)

    # adjustability
    for op in ops:
        op.adjustable = op.fixed is None

    problem = Problem(
        sim_start=sim_start,
        mode=mode,
        machines=machines,
        machine_ids=machine_ids,
        ops=ops,
        op_index=op_index,
        orders=orders,
        changeover_default=getattr(req, "changeoverDefault", 20),
        changeover_matrix=dict(getattr(req, "changeoverMatrix", None) or {}),
        old_plan=old_plan,
        affected=affected,
        delta_weights=_resolve_delta_weights(req),
    )

    _derive_structures(problem)
    _build_fixed_blocks(problem, conflicts)
    _precompute_old_sequences(problem)

    _pre_check(problem, conflicts)
    return problem


def _precompute_old_sequences(problem):
    if not problem.old_plan:
        return
    by_m = {}
    for op in problem.ops:
        old = problem.old_plan.get(op.operation_id)
        if op.is_new or old is None:
            continue
        by_m.setdefault(old[0], []).append((op.operation_id, old[1]))
    for seq in by_m.values():
        seq.sort(key=lambda x: (x[1], x[0]))
    problem.old_seq_by_machine = by_m


def _duration_on(op, machine_id):
    sp = op.cand_by_machine.get(machine_id)
    if sp is None:
        return None
    return sp[0] + sp[1]


def _pre_check(problem, conflicts):
    for op in problem.ops:
        valid_cands = []
        for m, setup, proc in op.candidates:
            if m not in problem.machines:
                conflicts.append(make_conflict(
                    "UNKNOWN_MACHINE", [op.operation_id, m], "ERROR",
                    "候选设备 %s 不在设备列表中" % m))
                continue
            valid_cands.append((m, setup, proc))
        if not valid_cands:
            conflicts.append(make_conflict(
                "NO_CANDIDATE_MACHINE", [op.operation_id], "ERROR",
                "该工序没有可用候选设备"))
            continue
        if op.adjustable:
            fits = any(
                (b - a) >= setup + proc
                for m, setup, proc in valid_cands
                for a, b in problem.machines[m].avail
            )
            if not fits:
                conflicts.append(make_conflict(
                    "NO_FEASIBLE_WINDOW", [op.operation_id], "ERROR",
                    "所有候选设备均无可容纳该工序的连续可用区间"))

    # hard lock sanity
    for op in problem.ops:
        if not op.hard_locked:
            continue
        machine, start, end, co = op.fixed
        if end <= start:
            conflicts.append(make_conflict(
                "E_VALIDATION", [op.operation_id], "ERROR",
                "硬锁定工序 endAt 必须大于 startAt"))
            continue
        if machine not in problem.machines:
            continue  # already reported
        block_a, block_b = start - co, end
        ok = any(a <= block_a and block_b <= b for a, b in problem.machines[machine].avail)
        if not ok:
            conflicts.append(make_conflict(
                "AVAILABILITY_VIOLATION", [op.operation_id, machine], "ERROR",
                "硬锁定工序占用区间未完整落在设备可用区间内"))
        if _duration_on(op, machine) is None:
            conflicts.append(make_conflict(
                "NOT_CANDIDATE_MACHINE", [op.operation_id, machine], "ERROR",
                "硬锁定设备不在该工序候选设备集合内"))
    # hard lock overlap per machine
    for m, blocks in problem.fixed_blocks.items():
        for i in range(1, len(blocks)):
            if blocks[i][0] < blocks[i - 1][1]:
                a = problem.ops[blocks[i - 1][2]].operation_id
                b = problem.ops[blocks[i][2]].operation_id
                conflicts.append(make_conflict(
                    "MACHINE_OVERLAP", [m, a, b], "ERROR",
                    "硬锁定工序在设备 %s 上时间重叠" % m))
    # hard lock precedence
    for order in problem.orders:
        seq = order.op_indices
        for k in range(1, len(seq)):
            prev = problem.ops[seq[k - 1]]
            cur = problem.ops[seq[k]]
            if prev.hard_locked and cur.hard_locked and prev.fixed[2] > cur.fixed[1]:
                conflicts.append(make_conflict(
                    "PRECEDENCE_VIOLATION",
                    [prev.operation_id, cur.operation_id], "ERROR",
                    "硬锁定工序违反工艺先后顺序"))
