import logging
import math
import random
import time
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

from .decoder import Schedule, decode
from .instance import MODE_BASELINE, Problem
from .kpi import compute_metrics, norm
from .models import AlgorithmParams
from .operators import (
    build_edd_os,
    build_ms_min_duration,
    build_ms_min_load,
    build_ms_random,
    build_mwkr_os,
    build_random_os,
    build_spt_os,
    mutate_ms,
    mutate_os,
    pox,
    uniform_crossover_ms,
)

# Infeasibility penalty per unplaceable operation. All other fitness terms are
# normalized by compute_bases() to roughly [0, population-scale weights], so
# 1e5 per penalized op dominates any feasible solution by orders of magnitude
# without risking float overflow.
PENALTY = 100000.0

# Upper bound for the evaluation cache. It is pure memoization (decoding is
# deterministic), so evicting entries only costs a re-decode, never correctness.
# 50k entries keep memory bounded even for extreme requests
# (populationSize<=2000, maxGenerations<=100000).
CACHE_MAX_ENTRIES = 50_000

# Per-generation evaluation cost budget in operation units (~pop x opCount).
# Each chromosome evaluation decodes all operations, so a large population on a
# large instance can exhaust timeLimitSeconds before the main loop even starts.
# populationSize is capped to POP_EVAL_BUDGET / opCount, floored at
# MIN_POPULATION so tiny requested populations (>=2) still pass through when
# they are under the budget.
POP_EVAL_BUDGET = 20_000
MIN_POPULATION = 20

logger = logging.getLogger(__name__)


class Chromosome:
    __slots__ = ("os_seq", "ms")

    def __init__(self, os_seq, ms):
        self.os_seq = os_seq
        self.ms = ms

    def copy(self):
        return Chromosome(list(self.os_seq), list(self.ms))

    def key(self):
        return (tuple(self.os_seq), tuple(self.ms))


class GAResult:
    def __init__(self, best_chrom, best_schedule, best_metrics, generations,
                 timed_out, termination_reason, timings=None):
        self.best_chrom = best_chrom
        self.best_schedule = best_schedule
        self.best_metrics = best_metrics
        self.generations = generations
        self.timed_out = timed_out
        self.termination_reason = termination_reason
        # phase timings in ms: initPopulationMs / evolutionMs / localSearchMs
        self.timings = timings or {}


def resolve_objective_weights(mode: str, ow: Dict[str, float]) -> Dict[str, float]:
    if mode == MODE_BASELINE:
        return {
            "cmax": float(ow.get("makespan", 0.4)),
            "tardiness": float(ow.get("weightedTardiness", 0.4)),
            "imbalance": float(ow.get("loadImbalance", 0.2)),
        }
    return {
        "tardiness": float(ow.get("weightedTardiness", 0.4)),
        "cmax": float(ow.get("makespan", 0.3)),
        "delta": float(ow.get("deltaPlan", 0.2)),
        "machineChange": float(ow.get("machineChange", 0.1)),
    }


class HybridGA:
    def __init__(self, problem: Problem, params: AlgorithmParams, weights: Dict[str, float]):
        self.problem = problem
        self.params = params
        self.weights = weights
        self.rng = random.Random(params.randomSeed)
        self.cache: "OrderedDict[Tuple, Tuple[int, float, Optional[Dict], Optional[Schedule]]]" = OrderedDict()
        # bumped whenever bases change; cached entries from an older bases
        # version are stale and recomputed lazily on next access
        self.bases_version = 0
        self.bases: Dict[str, float] = {
            "cmax": 0.0, "tWeighted": 0.0, "loadImbalance": 0.0,
            "deltaPlan": 0.0, "nMachineChange": 0.0,
        }

    # ---------------- evaluation ----------------

    def fitness_of(self, metrics: Dict, penalty_ops, overflow) -> float:
        w = self.weights
        b = self.bases
        if self.problem.mode == MODE_BASELINE:
            f = (w["cmax"] * norm(metrics["cmax"], b["cmax"])
                 + w["tardiness"] * norm(metrics["tWeighted"], b["tWeighted"])
                 + w["imbalance"] * norm(metrics["loadImbalance"], b["loadImbalance"]))
        else:
            f = (w["tardiness"] * norm(metrics["tWeighted"], b["tWeighted"])
                 + w["cmax"] * norm(metrics["cmax"], b["cmax"])
                 + w["delta"] * norm(metrics["delta"]["deltaPlan"], b["deltaPlan"])
                 + w["machineChange"] * norm(metrics["nMachineChange"], b["nMachineChange"]))
        if penalty_ops:
            f += PENALTY * len(penalty_ops) + overflow
        return f

    def evaluate(self, chrom: Chromosome, keep_solution: bool = False):
        key = chrom.key()
        hit = self.cache.get(key)
        if hit is not None and hit[0] == self.bases_version:
            schedule = hit[3]
            if keep_solution and schedule is None:
                # the entry was cached with keep_solution=False; decoding is
                # deterministic, so backfill the schedule into the cache entry
                # instead of making every caller re-decode on its own
                schedule = decode(self.problem, chrom.os_seq, chrom.ms)
                self.cache[key] = (hit[0], hit[1], hit[2], schedule)
            self.cache.move_to_end(key)
            return hit[1], hit[2], schedule
        schedule = decode(self.problem, chrom.os_seq, chrom.ms)
        metrics = compute_metrics(self.problem, schedule)
        fit = self.fitness_of(metrics, schedule.penalty_ops, schedule.overflow)
        entry = (self.bases_version, fit, metrics,
                 schedule if keep_solution else None)
        self.cache[key] = entry
        self.cache.move_to_end(key)
        if len(self.cache) > CACHE_MAX_ENTRIES:
            self.cache.popitem(last=False)
        return fit, metrics, entry[3]

    # ---------------- initialization ----------------

    def initial_population(self, pop_size: Optional[int] = None) -> List[Chromosome]:
        p = self.params
        mix = {"edd": 0.25, "spt": 0.15, "mwkr": 0.20, "random": 0.40}
        if p.initMix:
            for k in mix:
                if k in p.initMix:
                    mix[k] = float(p.initMix[k])
        if pop_size is None:
            pop_size = p.populationSize
        counts = {
            "edd": int(round(mix["edd"] * pop_size)),
            "spt": int(round(mix["spt"] * pop_size)),
            "mwkr": int(round(mix["mwkr"] * pop_size)),
        }
        counts["random"] = max(0, pop_size - counts["edd"] - counts["spt"] - counts["mwkr"])

        heuristic_os = []
        if counts["edd"] > 0:
            heuristic_os.append(("edd", build_edd_os(self.problem), counts["edd"]))
        if counts["spt"] > 0:
            heuristic_os.append(("spt", build_spt_os(self.problem), counts["spt"]))
        if counts["mwkr"] > 0:
            heuristic_os.append(("mwkr", build_mwkr_os(self.problem), counts["mwkr"]))

        ms_min_dur = build_ms_min_duration(self.problem)
        pop: List[Chromosome] = []
        for name, os_seq, cnt in heuristic_os:
            ms_load = build_ms_min_load(self.problem, os_seq)
            for i in range(cnt):
                if i % 2 == 0:
                    ms = list(ms_load)
                elif i % 3 == 0:
                    ms = build_ms_random(self.problem, self.rng)
                else:
                    ms = list(ms_min_dur)
                pop.append(Chromosome(list(os_seq), ms))
        for _ in range(counts["random"]):
            pop.append(Chromosome(build_random_os(self.problem, self.rng),
                                  build_ms_random(self.problem, self.rng)))
        # deterministic tie-break padding (should not trigger)
        while len(pop) < pop_size:
            pop.append(Chromosome(build_random_os(self.problem, self.rng),
                                  build_ms_random(self.problem, self.rng)))
        return pop[:pop_size]

    def compute_bases(self, pop: List[Chromosome], deadline: float) -> None:
        # normalization bases: metrics of the best initial individual
        best_fit, best_metrics = None, None
        for chrom in pop:
            fit, metrics, _s = self.evaluate(chrom)
            if best_fit is None or fit < best_fit:
                best_fit, best_metrics = fit, metrics
            if time.monotonic() >= deadline:
                # keep unit bases: cached entries stay valid under the current
                # bases_version, and run() will return the best-so-far anyway
                logger.warning("deadline hit during initial evaluation; "
                               "keeping unit normalization bases")
                return
        # first pass uses unit bases; recompute with bases fixed to this solution
        self.bases = {
            "cmax": best_metrics["cmax"],
            "tWeighted": best_metrics["tWeighted"],
            "loadImbalance": best_metrics["loadImbalance"],
            "deltaPlan": best_metrics["delta"]["deltaPlan"],
            "nMachineChange": best_metrics["nMachineChange"],
        }
        # entries cached under the unit bases are stale; invalidate them
        # lazily via the version tag instead of clearing the whole cache
        self.bases_version += 1

    # ---------------- genetic operators ----------------

    def tournament(self, scored):
        size = self.params.tournamentSize
        best = None
        for _ in range(size):
            cand = scored[self.rng.randrange(len(scored))]
            if best is None or cand[0] < best[0]:
                best = cand
        return best[1]

    def next_generation(self, scored) -> List[Chromosome]:
        p = self.params
        n_orders = len(self.problem.orders)
        elite_n = max(1, int(round(p.elitismRate * len(scored))))
        new_pop = [scored[i][1].copy() for i in range(elite_n)]
        while len(new_pop) < len(scored):
            pa = self.tournament(scored)
            pb = self.tournament(scored)
            ca, cb = pa.copy(), pb.copy()
            if self.rng.random() < p.crossoverRate:
                ca.os_seq, cb.os_seq = pox(pa.os_seq, pb.os_seq, n_orders, self.rng)
                ca.ms, cb.ms = uniform_crossover_ms(pa.ms, pb.ms, self.rng)
            if self.rng.random() < p.mutationRate:
                mutate_os(ca.os_seq, self.rng)
            if self.rng.random() < p.mutationRate:
                mutate_ms(self.problem, ca.ms, self.rng)
            new_pop.append(ca)
            if len(new_pop) < len(scored):
                if self.rng.random() < p.mutationRate:
                    mutate_os(cb.os_seq, self.rng)
                if self.rng.random() < p.mutationRate:
                    mutate_ms(self.problem, cb.ms, self.rng)
                new_pop.append(cb)
        return new_pop

    # ---------------- local search on the critical/bottleneck machine ----------------

    def local_search(self, chrom: Chromosome, max_trials: int, deadline: float) -> Chromosome:
        if max_trials <= 0 or not self.problem.adjustable_ops:
            return chrom
        best = chrom.copy()
        best_fit = self.evaluate(best)[0]
        trials = 0
        improved = True
        while improved and trials < max_trials and time.monotonic() < deadline:
            improved = False
            _fit, _m, schedule = self.evaluate(best, keep_solution=True)
            # bottleneck machine: machine of the operation ending at C_max
            cmax_end, cmax_machine = -1, None
            for m in self.problem.machine_ids:
                blocks = schedule.timelines[m]
                if blocks and blocks[-1][1] > cmax_end:
                    cmax_end, cmax_machine = blocks[-1][1], m
            if cmax_machine is None:
                break
            crit_ops = []
            for blk in schedule.timelines[cmax_machine]:
                op = self.problem.ops[blk[2]]
                if op.adjustable:
                    crit_ops.append(op)
            # move critical ops to alternative machines
            for op in crit_ops:
                if trials >= max_trials or time.monotonic() >= deadline:
                    break
                if len(op.candidates) < 2:
                    continue
                cur = best.ms[op.ms_pos]
                for ci in range(len(op.candidates)):
                    if ci == cur:
                        continue
                    cand = best.copy()
                    cand.ms[op.ms_pos] = ci
                    fit = self.evaluate(cand)[0]
                    trials += 1
                    if fit < best_fit - 1e-9:
                        best, best_fit = cand, fit
                        improved = True
                        break
                if improved:
                    break
            # swap adjacent critical operations in the OS sequence
            if not improved:
                for a, b in zip(crit_ops, crit_ops[1:]):
                    if trials >= max_trials or time.monotonic() >= deadline:
                        break
                    pa = schedule.os_positions.get(a.index)
                    pb = schedule.os_positions.get(b.index)
                    if pa is None or pb is None:
                        continue
                    cand = best.copy()
                    cand.os_seq[pa], cand.os_seq[pb] = cand.os_seq[pb], cand.os_seq[pa]
                    fit = self.evaluate(cand)[0]
                    trials += 1
                    if fit < best_fit - 1e-9:
                        best, best_fit = cand, fit
                        improved = True
                        break
        return best

    # ---------------- main loop ----------------

    def run(self) -> GAResult:
        p = self.params
        t0 = time.monotonic()
        deadline = t0 + p.timeLimitSeconds
        n_ops = max(1, len(self.problem.ops))
        pop_size = min(p.populationSize,
                       max(MIN_POPULATION, math.ceil(POP_EVAL_BUDGET / n_ops)))
        if pop_size < p.populationSize:
            logger.info("populationSize capped %d -> %d (opCount=%d)",
                        p.populationSize, pop_size, n_ops)

        t_init = time.monotonic()
        pop = self.initial_population(pop_size)
        self.compute_bases(pop, deadline)

        scored = []
        timed_out = False
        for chrom in pop:
            fit, metrics, _s = self.evaluate(chrom)
            scored.append((fit, chrom))
            if time.monotonic() >= deadline:
                timed_out = True
                break
        scored.sort(key=lambda x: x[0])
        init_ms = int((time.monotonic() - t_init) * 1000)

        best = scored[0][1].copy()
        best_fit = scored[0][0]
        generations = 0
        t_evo = time.monotonic()
        for gen in range(p.maxGenerations):
            if time.monotonic() >= deadline:
                timed_out = True
                break
            pop = self.next_generation(scored)
            scored = []
            aborted = False
            for chrom in pop:
                fit, _m, _s = self.evaluate(chrom)
                scored.append((fit, chrom))
                if time.monotonic() >= deadline:
                    aborted = True
                    break
            scored.sort(key=lambda x: x[0])
            generations += 1
            if scored[0][0] < best_fit - 1e-12:
                best = scored[0][1].copy()
                best_fit = scored[0][0]
            if aborted:
                timed_out = True
                break
        evolution_ms = int((time.monotonic() - t_evo) * 1000)

        termination_reason = "timeLimit" if timed_out else "maxGenerations"
        t_ls = time.monotonic()
        if p.localSearchTrials > 0 and time.monotonic() < deadline:
            best = self.local_search(best, p.localSearchTrials, deadline)
            termination_reason = ("timeLimit" if time.monotonic() >= deadline
                                  else "localSearch")
        local_search_ms = int((time.monotonic() - t_ls) * 1000)

        fit, metrics, schedule = self.evaluate(best, keep_solution=True)
        timings = {
            "initPopulationMs": init_ms,
            "evolutionMs": evolution_ms,
            "localSearchMs": local_search_ms,
        }
        logger.info("GA finished: generations=%d elapsedMs=%d bestFitness=%.6f "
                    "termination=%s penalizedOps=%d timings=%s",
                    generations, int((time.monotonic() - t0) * 1000), fit,
                    termination_reason, len(schedule.penalty_ops), timings)
        return GAResult(best, schedule, metrics, generations, timed_out,
                        termination_reason, timings)
