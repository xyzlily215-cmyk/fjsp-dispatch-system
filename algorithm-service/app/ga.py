import logging
import math
import random
import time
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

from .decoder import BE, BS, Schedule, decode
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

# Stagnation-triggered random immigrants. When the global best has not
# improved for STAGNATION_THRESHOLD consecutive generations the population is
# treated as prematurely converged (common on large instances); the worst
# IMMIGRANT_RATIO fraction of non-elite individuals is replaced by fresh
# random chromosomes to re-inject diversity while the elites keep the
# incumbent solution safe. 15 generations is long enough to tell a real
# plateau from normal drift on 60-300 generation budgets; 15% is enough to
# matter under tournament selection without destroying building blocks.
STAGNATION_THRESHOLD = 15
IMMIGRANT_RATIO = 0.15

# Extended local-search neighborhood sizes. Every candidate move costs one
# decode (counted against the localSearchTrials budget), so the sets are kept
# small and share the existing trials counter.
LS_TARDY_CRIT_OPS = 5       # top weighted-tardiness ops added to the critical set
LS_OS_REINSERT_SAMPLES = 4  # insertion positions sampled per critical op

# Memetic seeding: before evolution starts, the top LS_SEED_TOP_K heuristic
# individuals are each polished by the composite-neighborhood local search
# (LS_SEED_TRIALS decodes apiece) and written back in place. Dispatch-rule
# solutions are far from local optima (measured: fitness improves ~5-15%
# here), so evolution starts from strong, still-diverse incumbents. Spreading
# the budget over 3 individuals instead of refining a single super-elite
# avoids premature takeover of the tournament pool; the total extra cost is
# 3x25 decodes, well under one generation's evaluations at default pop size.
LS_SEED_TOP_K = 3
LS_SEED_TRIALS = 25

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
                 timed_out, termination_reason, timings=None,
                 stagnation_restarts=0):
        self.best_chrom = best_chrom
        self.best_schedule = best_schedule
        self.best_metrics = best_metrics
        self.generations = generations
        self.timed_out = timed_out
        self.termination_reason = termination_reason
        # phase timings in ms: initPopulationMs / evolutionMs / localSearchMs
        self.timings = timings or {}
        # number of stagnation-triggered random-immigrant injections
        self.stagnation_restarts = stagnation_restarts


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
            tried_ms_moves = set()
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
                    tried_ms_moves.add((op.index, ci))
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
            # extended critical set: bottleneck ops plus the top weighted-
            # tardiness ops (the tardiness-critical path, not only C_max)
            if not improved:
                ext_crit = list(crit_ops)
                seen = set(op.index for op in ext_crit)
                tardy = []
                for op in self.problem.adjustable_ops:
                    if op.index in seen:
                        continue
                    pl = schedule.placements[op.index]
                    if pl is not None and pl[2] > op.due:
                        tardy.append(((pl[2] - op.due) * op.weight, op.index, op))
                tardy.sort(reverse=True)
                ext_crit.extend(op for _t, _i, op in tardy[:LS_TARDY_CRIT_OPS])
                # per-machine occupied minutes, used to prefer unloaded targets
                load = {m: sum(blk[BE] - blk[BS] for blk in schedule.timelines[m])
                        for m in self.problem.machine_ids}
                # cross-machine move: shift a critical op onto a feasible
                # candidate machine, least-loaded first (MS gene + re-decode)
                for op in ext_crit:
                    if trials >= max_trials or time.monotonic() >= deadline:
                        break
                    if len(op.candidates) < 2:
                        continue
                    cur = best.ms[op.ms_pos]
                    by_load = sorted(range(len(op.candidates)),
                                     key=lambda ci: (load[op.candidates[ci][0]], ci))
                    for ci in by_load:
                        if ci == cur or (op.index, ci) in tried_ms_moves:
                            continue
                        if trials >= max_trials or time.monotonic() >= deadline:
                            break
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
            # OS reinsertion: move a critical op's OS gene to another position.
            # The OS chromosome is a multiset permutation (k-th occurrence of an
            # order decodes to its k-th op), so pop+insert keeps the occurrence
            # counts unchanged and precedence feasibility is guaranteed by the
            # decoder -- the same invariant mutate_os's insertion branch and POX
            # rely on.
            if not improved:
                n_os = len(best.os_seq)
                for op in ext_crit:
                    if trials >= max_trials or time.monotonic() >= deadline:
                        break
                    p0 = schedule.os_positions.get(op.index)
                    if p0 is None or n_os < 2:
                        continue
                    for j in self.rng.sample(range(n_os),
                                             min(LS_OS_REINSERT_SAMPLES, n_os)):
                        if j == p0:
                            continue
                        if trials >= max_trials or time.monotonic() >= deadline:
                            break
                        cand = best.copy()
                        g = cand.os_seq.pop(p0)
                        cand.os_seq.insert(j, g)
                        fit = self.evaluate(cand)[0]
                        trials += 1
                        if fit < best_fit - 1e-9:
                            best, best_fit = cand, fit
                            improved = True
                            break
                    if improved:
                        break
        return best

    # ---------------- stagnation perturbation ----------------

    def inject_immigrants(self, scored, deadline):
        """Replace the worst IMMIGRANT_RATIO fraction of the population (elites
        excluded) with fresh random chromosomes. `scored` is sorted by fitness
        and its size is preserved. Returns the original list untouched when
        there is nothing to replace or the deadline is too close to finish the
        injection (a partial injection would shrink the population)."""
        elite_n = max(1, int(round(self.params.elitismRate * len(scored))))
        n_rep = min(int(round(IMMIGRANT_RATIO * len(scored))),
                    len(scored) - elite_n)
        if n_rep <= 0:
            return scored
        immigrants = []
        for _ in range(n_rep):
            if time.monotonic() >= deadline:
                return scored
            imm = Chromosome(build_random_os(self.problem, self.rng),
                             build_ms_random(self.problem, self.rng))
            immigrants.append((self.evaluate(imm)[0], imm))
        new_scored = scored[:len(scored) - n_rep] + immigrants
        new_scored.sort(key=lambda x: x[0])
        return new_scored

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
        # memetic seeding: polish the top heuristic (dispatch-rule) individuals
        # with the composite-neighborhood local search and write them back in
        # place, so evolution starts from strong yet diverse incumbents
        if not timed_out and p.localSearchTrials > 0:
            for k in range(min(LS_SEED_TOP_K, len(scored))):
                if time.monotonic() >= deadline:
                    break
                refined = self.local_search(scored[k][1], LS_SEED_TRIALS, deadline)
                refined_fit = self.evaluate(refined)[0]
                if refined_fit < scored[k][0] - 1e-12:
                    scored[k] = (refined_fit, refined)
            scored.sort(key=lambda x: x[0])
        init_ms = int((time.monotonic() - t_init) * 1000)

        best = scored[0][1].copy()
        best_fit = scored[0][0]
        generations = 0
        stagnant = 0
        stagnation_restarts = 0
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
                stagnant = 0
            else:
                stagnant += 1
            if aborted:
                timed_out = True
                break
            if stagnant >= STAGNATION_THRESHOLD and time.monotonic() < deadline:
                perturbed = self.inject_immigrants(scored, deadline)
                if perturbed is not scored:
                    scored = perturbed
                    stagnation_restarts += 1
                stagnant = 0
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
                    "termination=%s penalizedOps=%d stagnationRestarts=%d timings=%s",
                    generations, int((time.monotonic() - t0) * 1000), fit,
                    termination_reason, len(schedule.penalty_ops),
                    stagnation_restarts, timings)
        return GAResult(best, schedule, metrics, generations, timed_out,
                        termination_reason, timings, stagnation_restarts)
