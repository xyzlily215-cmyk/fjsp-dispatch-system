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
