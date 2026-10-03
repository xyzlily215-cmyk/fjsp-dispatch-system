from typing import List, Optional, Tuple

from .instance import INF, Problem

# Block layout (machine timeline entry):
# [blockStart, endAt, opIndex, startAt, changeover, family, completed, fixed]
# blockStart = startAt - changeover  -> the machine is occupied on [blockStart, endAt)

BS, BE, BOP, BST, BCO, BFAM, BCMP, BFIX = range(8)


class Schedule:
    __slots__ = ("placements", "timelines", "penalty_ops", "overflow", "os_positions")

    def __init__(self, placements, timelines, penalty_ops, overflow, os_positions):
        # placements[opIndex] = (machineId, startAt, endAt, changeover)
        self.placements = placements
        self.timelines = timelines
        self.penalty_ops = penalty_ops
        self.overflow = overflow
        self.os_positions = os_positions

    @property
    def feasible(self):
        return not self.penalty_ops


def _interval_start(avail, t):
    for a, b in avail:
        if a <= t < b:
            return a
        if a > t:
            break
    return None


def _try_slot(problem, slot_a, slot_b, pred, succ, succ_iv_start,
              ready, dur, family, completed, max_end):
    if pred is None:
        co = 0
    else:
        co = problem.changeover(pred[BFAM], family, pred[BCMP], completed)
    t = ready
    min_t = slot_a + co
    if t < min_t:
        t = min_t
    if succ is None:
        limit = slot_b
        if limit > max_end:
            limit = max_end
        if t + dur <= limit:
            return (t, co, None)
        return None
    co_new = problem.changeover(family, succ[BFAM], completed, succ[BCMP])
    if succ[BFIX] == 2:
        # hard-locked successor: its recorded changeover is immutable
        if co_new != succ[BCO]:
            return None
        limit = succ[BS]
    elif succ[BFIX] == 1:
        # LOCAL equality-fixed successor: startAt immutable; its changeover may
        # only shrink relative to the reserved old-plan value
        if co_new > succ[BCO]:
            return None
        limit = succ[BS]
    else:
        limit = succ[BST] - co_new
        # the successor's changeover block must stay inside its own interval
        if succ_iv_start is None or limit < succ_iv_start:
            return None
    if limit > slot_b:
        limit = slot_b
    if limit > max_end:
        limit = max_end
    if t + dur <= limit:
        return (t, co, succ)
    return None


def place(problem, blocks, avail, ready, dur, family, completed, max_end):
    """Earliest feasible placement of one operation on one machine.

    Returns (startAt, changeoverBefore, successorBlockOrNone) or None.
    """
    best = None
    prev = None
    idx = 0
    nb = len(blocks)
    for a, b in avail:
        while idx < nb and blocks[idx][BE] <= a:
            prev = blocks[idx]
            idx += 1
        slot_start = a
        j = idx
        while j < nb and blocks[j][BS] < b:
            blk = blocks[j]
            if blk[BE] > b:
                break
            cand = _try_slot(problem, slot_start, blk[BS], prev, blk, a,
                             ready, dur, family, completed, max_end)
            if cand is not None and (best is None or cand[0] < best[0]):
                best = cand
            slot_start = blk[BE]
            prev = blk
            j += 1
        idx = j
        # trailing slot of this interval; the true successor may live in a
        # later interval and its changeover depends on this placement
        succ = blocks[j] if j < nb else None
        succ_iv = _interval_start(avail, succ[BST]) if succ is not None else None
        cand = _try_slot(problem, slot_start, b, prev, succ, succ_iv,
                         ready, dur, family, completed, max_end)
        if cand is not None and (best is None or cand[0] < best[0]):
            best = cand
    return best


def _insert_block(blocks, block):
    # linear insertion, block lists stay short (ops per machine)
    lo, hi = 0, len(blocks)
    key = block[BS]
    while lo < hi:
        mid = (lo + hi) // 2
        if blocks[mid][BS] < key:
            lo = mid + 1
        else:
            hi = mid
    blocks.insert(lo, block)


def decode(problem: Problem, os_seq: List[int], ms_genes: List[int]) -> Schedule:
    timelines = {m: list(problem.fixed_blocks[m]) for m in problem.machine_ids}
    placements: List[Optional[Tuple[str, int, int, int]]] = [None] * len(problem.ops)
    for op in problem.ops:
        if op.fixed is not None:
            machine, start, end, co = op.fixed
            placements[op.index] = (machine, start, end, co)

    counters = [0] * len(problem.orders)
    os_positions = {}
    penalty_ops = []
    overflow = 0
    for pos, oi in enumerate(os_seq):
        k = counters[oi]
        counters[oi] = k + 1
        op = problem.adjustable_by_order[oi][k]
        os_positions[op.index] = pos
        prev_idx = problem.prev_op[op.index]
        ready = op.release
        if prev_idx >= 0:
            prev_end = placements[prev_idx][2]
            if prev_end > ready:
                ready = prev_end
        nxt = problem.next_op[op.index]
        max_end = INF
        if nxt >= 0 and problem.ops[nxt].fixed is not None:
            max_end = problem.ops[nxt].fixed[1]

        ci = ms_genes[op.ms_pos]
        machine, setup, proc = op.candidates[ci]
        dur = setup + proc
        blocks = timelines[machine]
        res = place(problem, blocks, problem.machines[machine].avail,
                    ready, dur, op.family, op.completed, max_end)
        if res is None:
            # infeasible fallback: append after the last block; heavily penalized
            if blocks:
                last = blocks[-1]
                co = problem.changeover(last[BFAM], op.family, last[BCMP], op.completed)
                t = last[BE] + co
                if t < ready:
                    t = ready
            else:
                co = 0
                t = ready
            block = [t - co, t + dur, op.index, t, co, op.family, op.completed, 0]
            blocks.append(block)
            placements[op.index] = (machine, t, t + dur, co)
            penalty_ops.append(op.operation_id)
            overflow += (t + dur) - ready + 1
            continue
        t, co, succ = res
        block = [t - co, t + dur, op.index, t, co, op.family, op.completed, 0]
        _insert_block(blocks, block)
        if succ is not None and succ[BFIX] == 0:
            co_new = problem.changeover(op.family, succ[BFAM], op.completed, succ[BCMP])
            if co_new != succ[BCO]:
                succ[BCO] = co_new
                succ[BS] = succ[BST] - co_new
        placements[op.index] = (machine, t, t + dur, co)

    # normalize changeover of every non-hard block against its final machine
    # predecessor (covers successors updated after their own placement and
    # LOCAL equality-fixed ops whose reserved changeover shrank)
    for m in problem.machine_ids:
        prev = None
        for blk in timelines[m]:
            if blk[BFIX] != 2:
                expected = 0
                if prev is not None:
                    expected = problem.changeover(prev[BFAM], blk[BFAM],
                                                  prev[BCMP], blk[BCMP])
                if expected != blk[BCO]:
                    blk[BCO] = expected
                    blk[BS] = blk[BST] - expected
                pl = placements[blk[BOP]]
                if pl is not None and pl[3] != blk[BCO]:
                    placements[blk[BOP]] = (pl[0], pl[1], pl[2], blk[BCO])
            prev = blk

    return Schedule(placements, timelines, penalty_ops, overflow, os_positions)
