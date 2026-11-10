import time
from unittest.mock import patch

import app.ga as ga_module
from app.decoder import decode
from app.ga import HybridGA, resolve_objective_weights
from app.instance import build_problem
from app.models import SolveRequest
from conftest import tiny_request


def _make_ga():
    req = SolveRequest(**tiny_request())
    conflicts = []
    problem = build_problem(req, conflicts)
    assert problem is not None, conflicts
    weights = resolve_objective_weights(problem.mode, req.objectiveWeights)
    return HybridGA(problem, req.algorithm, weights)


def test_evaluate_backfills_schedule_on_keep_solution_hit():
    ga = _make_ga()
    chrom = ga.initial_population(2)[0]

    # first evaluation caches the entry without a schedule
    fit1, metrics1, schedule1 = ga.evaluate(chrom)
    assert schedule1 is None

    # hitting the same entry with keep_solution=True must backfill the
    # schedule instead of returning None to the caller
    fit2, metrics2, schedule2 = ga.evaluate(chrom, keep_solution=True)
    assert schedule2 is not None
    assert fit2 == fit1
    assert metrics2 is metrics1

    # decoding is deterministic: the backfilled schedule matches a fresh decode
    fresh = decode(ga.problem, chrom.os_seq, chrom.ms)
    assert schedule2.placements == fresh.placements

    # the cache entry itself was updated, so later hits carry the schedule too
    entry = ga.cache[chrom.key()]
    assert entry[3] is schedule2
    _fit, _m, schedule3 = ga.evaluate(chrom, keep_solution=True)
    assert schedule3 is schedule2


def test_changed_bases_rescore_metrics_without_decoding():
    ga = _make_ga()
    chrom = ga.initial_population(2)[0]
    with patch("app.ga.decode", wraps=decode) as decoding, \
            patch("app.ga.compute_metrics", wraps=ga_module.compute_metrics) as computing:
        before, metrics, _ = ga.evaluate(chrom)
        ga.bases = {key: 100.0 for key in ga.bases}
        ga.bases_version += 1
        after, reused, schedule = ga.evaluate(chrom)
        assert decoding.call_count == computing.call_count == 1
        assert reused is metrics
        assert schedule is None
        assert before != after
        decoded = decode(ga.problem, chrom.os_seq, chrom.ms)
        assert after == ga.fitness_of(metrics, decoded.penalty_ops, decoded.overflow)


def test_compute_bases_keeps_only_metrics_and_reuses_initial_evaluations():
    ga = _make_ga()
    pop = ga.initial_population(10)
    with patch("app.ga.decode", wraps=decode) as decoding:
        ga.compute_bases(pop, time.monotonic() + 30)
        count = decoding.call_count
        for chrom in pop:
            ga.evaluate(chrom)
        assert decoding.call_count == count
    assert all(entry[3] is None for entry in ga.cache.values())


def test_rescoring_infeasible_chromosome_keeps_its_penalty():
    ga = _make_ga()
    for machine in ga.problem.machines.values():
        machine.avail = [(0, 1)]
    chrom = ga.initial_population(2)[0]
    _, metrics, _ = ga.evaluate(chrom)
    fresh = decode(ga.problem, chrom.os_seq, chrom.ms)
    assert fresh.penalty_ops
    ga.bases_version += 1
    with patch("app.ga.decode", wraps=decode) as decoding:
        fit, _, _ = ga.evaluate(chrom)
        decoding.assert_not_called()
    assert fit == ga.fitness_of(metrics, fresh.penalty_ops, fresh.overflow)


def test_compute_bases_deadline_keeps_unit_bases():
    ga = _make_ga()
    ga.compute_bases(ga.initial_population(2), time.monotonic() - 1)
    assert ga.bases_version == 0
    assert all(entry[3] is None for entry in ga.cache.values())
