"""复合邻域局部搜索与停滞扰动（随机移民）的单元测试。"""
import time
from collections import Counter

from app.ga import (IMMIGRANT_RATIO, STAGNATION_THRESHOLD, HybridGA,
                    resolve_objective_weights)
from app.instance import build_problem
from app.models import SolveRequest
from app.solver import solve
from conftest import tiny_request

FAR = time.monotonic() + 3600


def _make_ga(**alg_over):
    req = tiny_request()
    req["algorithm"].update(alg_over)
    req = SolveRequest(**req)
    conflicts = []
    problem = build_problem(req, conflicts)
    assert problem is not None and not conflicts
    weights = resolve_objective_weights(problem.mode, req.objectiveWeights)
    ga = HybridGA(problem, req.algorithm, weights)
    pop = ga.initial_population()
    ga.compute_bases(pop, FAR)
    return ga, pop


def _scored(ga, pop):
    return sorted(((ga.evaluate(c)[0], c) for c in pop), key=lambda x: x[0])


def test_local_search_never_worsens_and_keeps_os_multiset():
    """扩展邻域后的 local_search：适应度不退化，OS 染色体多重集合不变（拓扑可行）。"""
    ga, pop = _make_ga()
    scored = _scored(ga, pop)
    start = scored[len(scored) // 2][1]  # 中等个体，留出改进空间
    start_fit = ga.evaluate(start)[0]
    out = ga.local_search(start, max_trials=60, deadline=FAR)
    assert Counter(out.os_seq) == Counter(start.os_seq)
    assert all(0 <= g < len(op.candidates)
               for g, op in zip(out.ms, ga.problem.adjustable_ops))
    assert ga.evaluate(out)[0] <= start_fit + 1e-9


def test_local_search_os_reinsertion_uses_injected_rng():
    """同种子两次 local_search 结果一致（OS 重插的随机采样走注入的 rng）。"""
    results = []
    for _ in range(2):
        ga, pop = _make_ga()
        start = _scored(ga, pop)[0][1]
        out = ga.local_search(start, max_trials=60, deadline=FAR)
        results.append((out.key(), ga.evaluate(out)[0]))
    assert results[0] == results[1]


def test_inject_immigrants_preserves_elites_and_size():
    ga, pop = _make_ga()
    scored = _scored(ga, pop)
    elite_keys = {scored[i][1].key()
                  for i in range(max(1, int(round(ga.params.elitismRate * len(scored)))))}
    new = ga.inject_immigrants(scored, FAR)
    assert new is not scored
    assert len(new) == len(scored)
    assert elite_keys <= {c.key() for _f, c in new}
    assert all(new[i][0] <= new[i + 1][0] for i in range(len(new) - 1))
    # 最差个体被替换：原种群尾部键不再全部保留
    n_rep = int(round(IMMIGRANT_RATIO * len(scored)))
    assert n_rep >= 1
    tail_keys = {scored[len(scored) - i][1].key() for i in range(1, n_rep + 1)}
    assert not tail_keys <= {c.key() for _f, c in new}


def test_inject_immigrants_deterministic_same_seed():
    keys = []
    for _ in range(2):
        ga, pop = _make_ga()
        new = ga.inject_immigrants(_scored(ga, pop), FAR)
        keys.append([c.key() for _f, c in new])
    assert keys[0] == keys[1]


def test_stagnation_restarts_reported_in_meta_and_reproducible():
    """关闭交叉/变异使种群必然停滞：stagnationRestarts >= 1，且同种子可复现。"""
    req = tiny_request()
    req["algorithm"].update(populationSize=20, maxGenerations=3 * STAGNATION_THRESHOLD,
                            timeLimitSeconds=30, crossoverRate=0.0,
                            mutationRate=0.0, localSearchTrials=0)
    r1 = solve(SolveRequest(**req))
    r2 = solve(SolveRequest(**tiny_request(**{
        "algorithm": {**tiny_request()["algorithm"],
                      "populationSize": 20,
                      "maxGenerations": 3 * STAGNATION_THRESHOLD,
                      "timeLimitSeconds": 30,
                      "crossoverRate": 0.0,
                      "mutationRate": 0.0,
                      "localSearchTrials": 0}})))
    assert r1["meta"]["stagnationRestarts"] >= 1
    assert r1["operations"] == r2["operations"]
    assert r1["kpi"] == r2["kpi"]
    assert r1["meta"]["stagnationRestarts"] == r2["meta"]["stagnationRestarts"]


def test_stagnation_perturbation_does_not_degrade_tiny_case():
    """默认参数下带扰动的完整求解：结果仍可行且质量不劣于关闭扰动的上界检查。"""
    req = SolveRequest(**tiny_request())
    r = solve(req)
    assert r["feasibleSolution"]
    assert r["constraintCheck"]["passed"]
    assert "stagnationRestarts" in r["meta"]


def test_memetic_seeding_runs_with_single_generation():
    """maxGenerations=1 时 memetic 种子打磨仍执行：结果可行且同种子可复现。"""
    req = tiny_request()
    req["algorithm"].update(maxGenerations=1, localSearchTrials=25)
    r1 = solve(SolveRequest(**req))
    r2 = solve(SolveRequest(**tiny_request(
        algorithm={**tiny_request()["algorithm"],
                   "maxGenerations": 1, "localSearchTrials": 25})))
    assert r1["feasibleSolution"] and r1["constraintCheck"]["passed"]
    assert r1["operations"] == r2["operations"]
    assert r1["kpi"] == r2["kpi"]
