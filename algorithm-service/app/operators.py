import random
from typing import List, Tuple

from .instance import Problem


# ---------------- initial OS sequences ----------------

def build_edd_os(problem: Problem) -> List[int]:
    items = []
    for order in problem.orders:
        for k, _op in enumerate(problem.adjustable_by_order[order.order_idx]):
            items.append((order.due, order.order_idx, k))
    items.sort()
    return [order_idx for _due, order_idx, _k in items]


def build_spt_os(problem: Problem) -> List[int]:
    items = []
    for order in problem.orders:
        for k, op in enumerate(problem.adjustable_by_order[order.order_idx]):
            min_proc = min(p for _m, _s, p in op.candidates)
            items.append((min_proc, order.order_idx, k))
    items.sort()
    return [order_idx for _p, order_idx, _k in items]


def build_mwkr_os(problem: Problem) -> List[int]:
    remaining = []
    for order in problem.orders:
        work = sum(min(p for _m, _s, p in op.candidates)
                   for op in problem.adjustable_by_order[order.order_idx])
        remaining.append(work)
    progressed = [0] * len(problem.orders)
    total = sum(1 for op in problem.ops if op.adjustable)
    seq = []
    for _ in range(total):
        best_j, best_w = -1, -1
        for order in problem.orders:
            j = order.order_idx
            if progressed[j] < len(problem.adjustable_by_order[j]) and remaining[j] > best_w:
                best_j, best_w = j, remaining[j]
        op = problem.adjustable_by_order[best_j][progressed[best_j]]
        progressed[best_j] += 1
        remaining[best_j] -= min(p for _m, _s, p in op.candidates)
        seq.append(best_j)
    return seq


def build_random_os(problem: Problem, rng: random.Random) -> List[int]:
    seq = []
    for order in problem.orders:
        seq.extend([order.order_idx] * len(problem.adjustable_by_order[order.order_idx]))
    rng.shuffle(seq)
    return seq


# ---------------- initial MS genes ----------------

def build_ms_min_duration(problem: Problem) -> List[int]:
    genes = []
    for op in problem.adjustable_ops:
        best_i, best_d = 0, None
        for i, (_m, setup, proc) in enumerate(op.candidates):
            d = setup + proc
            if best_d is None or d < best_d:
                best_i, best_d = i, d
        genes.append(best_i)
    return genes


def build_ms_min_load(problem: Problem, os_seq: List[int]) -> List[int]:
    """Greedy least-loaded machine assignment following the OS order."""
    load = dict((m, 0) for m in problem.machine_ids)
    for m, blocks in problem.fixed_blocks.items():
        for blk in blocks:
            load[m] += blk[1] - blk[0]
    genes = [0] * len(problem.adjustable_ops)
    counters = [0] * len(problem.orders)
    for oi in os_seq:
        k = counters[oi]
        counters[oi] = k + 1
        op = problem.adjustable_by_order[oi][k]
        best_i, best_key = 0, None
        for i, (m, setup, proc) in enumerate(op.candidates):
            avail_min = problem.machines[m].avail_minutes
            key = (load[m] + setup + proc) / avail_min if avail_min > 0 else 1e18
            key = (key, setup + proc)
            if best_key is None or key < best_key:
                best_i, best_key = i, key
        genes[op.ms_pos] = best_i
        m, setup, proc = op.candidates[best_i]
        load[m] += setup + proc
    return genes


def build_ms_random(problem: Problem, rng: random.Random) -> List[int]:
    return [rng.randrange(len(op.candidates)) for op in problem.adjustable_ops]


# ---------------- crossover ----------------

def pox(p1: List[int], p2: List[int], n_orders: int, rng: random.Random) -> Tuple[List[int], List[int]]:
    """Precedence-preserving order crossover for the OS layer."""
    j1 = set(j for j in range(n_orders) if rng.random() < 0.5)

    def child(pa, pb):
        c = list(pa)
        fill = [g for g in pb if g not in j1]
        it = iter(fill)
        for i, g in enumerate(pa):
            if g not in j1:
                c[i] = next(it)
        return c

    return child(p1, p2), child(p2, p1)


def uniform_crossover_ms(m1: List[int], m2: List[int], rng: random.Random) -> Tuple[List[int], List[int]]:
    c1 = [a if rng.random() < 0.5 else b for a, b in zip(m1, m2)]
    c2 = [b if rng.random() < 0.5 else a for a, b in zip(m1, m2)]
    return c1, c2


# ---------------- mutation ----------------

def mutate_os(os_seq: List[int], rng: random.Random) -> None:
    n = len(os_seq)
    if n < 2:
        return
    if rng.random() < 0.5:
        # swap
        i, j = rng.randrange(n), rng.randrange(n)
        os_seq[i], os_seq[j] = os_seq[j], os_seq[i]
    else:
        # insertion
        i, j = rng.randrange(n), rng.randrange(n)
        g = os_seq.pop(i)
        os_seq.insert(j, g)


def mutate_ms(problem: Problem, ms: List[int], rng: random.Random) -> None:
    multi = [op.ms_pos for op in problem.adjustable_ops if len(op.candidates) > 1]
    if not multi:
        return
    pos = multi[rng.randrange(len(multi))]
    op = problem.adjustable_ops[pos]
    cur = ms[pos]
    n = len(op.candidates)
    new = rng.randrange(n - 1)
    if new >= cur:
        new += 1
    ms[pos] = new
