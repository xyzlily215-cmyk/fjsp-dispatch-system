"""算法质量基线：不只验证"能求解"，而是固定实例、固定种子下的质量与耗时基线。

- 小型（demo 实例，~80 工序）：同种子可复现 + 相对调度规则派工参考解的质量改进；
- 中型（~150 工序）：10s 限时内 P50/P95 耗时与可行率；
- 大型（~600 工序，slow）：TIME_LIMIT 下按时结束且可行；
- 重调度：局部重调度相对完全重调度的变更量对比（答辩演示点）。
"""
import json
import os
import random
import statistics
import subprocess
import sys
import time

import pytest

from app.models import SolveRequest
from app.solver import solve

ALGO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_PATH = os.path.join(ALGO_DIR, "demo_instance.json")

SIM_START = "2026-09-16T08:00:00+08:00"
FAMILIES = ["F1", "F2", "F3"]
CHANGEOVER = {"F1|F2": 30, "F2|F1": 30, "F2|F3": 35, "F3|F2": 35,
              "F3|F1": 40, "F1|F3": 40}


def _ensure_demo():
    if not os.path.exists(DEMO_PATH):
        script = os.path.join(ALGO_DIR, "scripts", "generate_demo.py")
        subprocess.run([sys.executable, script], check=True)


def _load_demo():
    _ensure_demo()
    with open(DEMO_PATH, encoding="utf-8") as f:
        return json.load(f)


def synth_instance(n_orders, n_machines, seed, work_days=5):
    """合成实例生成器：family/候选数/交期松紧的参数模式与 scripts/generate_demo.py 一致。

    设备能力按轮转分配，保证每个 family 至少在 3 台设备上可加工。
    work_days 需随订单规模放大，否则总工时超过产能导致不可行。
    """
    rng = random.Random(seed)
    machines = []
    for i in range(n_machines):
        fams = [FAMILIES[(i + k) % len(FAMILIES)] for k in range(rng.randint(1, 3))]
        fams = sorted(set(fams))
        intervals = []
        for d in range(work_days):
            base = d * 1440
            intervals.append([base, base + 240])
            intervals.append([base + 300, base + 540])
        machines.append({
            "machineId": "M%02d" % (i + 1),
            "workCenterId": "WC%d" % (i % 3 + 1),
            "productFamilies": fams,
            "availableIntervals": intervals,
        })
    capable = {fam: [m["machineId"] for m in machines if fam in m["productFamilies"]]
               for fam in FAMILIES}
    assert all(capable[f] for f in FAMILIES)

    orders = []
    for i in range(1, n_orders + 1):
        oid = "O%04d" % i
        fam = FAMILIES[rng.randrange(len(FAMILIES))]
        n_ops = rng.randint(3, 5)
        operations = []
        total_min_proc = 0
        for k in range(1, n_ops + 1):
            pool = list(capable[fam])
            rng.shuffle(pool)
            cands = [{"machineId": m,
                      "processMinutes": rng.randint(20, 90),
                      "setupMinutes": rng.randint(5, 15)}
                     for m in pool[:rng.randint(1, 3)]]
            total_min_proc += min(c["processMinutes"] + c["setupMinutes"] for c in cands)
            operations.append({"operationId": "%s-%02d" % (oid, k * 10),
                               "seqNo": k * 10, "candidates": cands})
        arrival = 0 if i <= n_orders // 2 else rng.choice([120, 240, 360, 480])
        tight = rng.random() < 0.45
        factor = rng.uniform(1.6, 2.2) if tight else rng.uniform(3.0, 4.5)
        orders.append({
            "orderId": oid, "productFamily": fam,
            "quantity": rng.randint(5, 60),
            "arrivalMinutes": arrival,
            "dueMinutes": arrival + int(total_min_proc * factor),
            "priority": rng.choices([1, 2, 3, 4, 5], weights=[2, 3, 5, 3, 2])[0],
            "operations": operations,
        })
    return {
        "mode": "BASELINE",
        "simulationStartAt": SIM_START,
        "machines": machines,
        "orders": orders,
        "changeoverDefault": 20,
        "changeoverMatrix": dict(CHANGEOVER),
        "objectiveWeights": {"makespan": 0.4, "weightedTardiness": 0.4,
                             "loadImbalance": 0.2},
        "algorithm": {"populationSize": 100, "maxGenerations": 300,
                      "timeLimitSeconds": 60, "randomSeed": seed},
    }


def _solve(data):
    return solve(SolveRequest(**data))


def _old_plan(resp):
    return [{
        "operationId": op["operationId"],
        "machineId": op["machineId"],
        "startAtMinutes": op["startAtMinutes"],
        "endAtMinutes": op["endAtMinutes"],
        "changeoverMinutes": op["changeoverMinutes"],
    } for op in resp["operations"]]


def test_small_demo_reproducible_same_seed():
    data = _load_demo()
    data["algorithm"]["populationSize"] = 100
    data["algorithm"]["maxGenerations"] = 200
    data["algorithm"]["timeLimitSeconds"] = 20
    r1 = _solve(data)
    r2 = _solve(json.loads(json.dumps(data)))
    assert r1["feasibleSolution"] and r2["feasibleSolution"]
    assert r1["operations"] == r2["operations"]
    assert r1["kpi"] == r2["kpi"]
    assert set(r1["meta"]["timings"]) == {
        "buildProblemMs", "initPopulationMs", "evolutionMs",
        "localSearchMs", "validateMs"}


def test_small_demo_improves_over_dispatch_reference():
    """完整 GA 相对"调度规则派工"参考解（仅启发式初始种群、不进化）的质量改进基线。"""
    data = _load_demo()
    data["algorithm"]["populationSize"] = 100
    data["algorithm"]["maxGenerations"] = 200
    data["algorithm"]["timeLimitSeconds"] = 20
    full = _solve(data)

    ref_data = json.loads(json.dumps(data))
    ref_data["algorithm"]["maxGenerations"] = 1
    ref_data["algorithm"]["localSearchTrials"] = 0
    ref = _solve(ref_data)

    assert full["feasibleSolution"] and ref["feasibleSolution"]
    ref_t = ref["kpi"]["weightedTardinessMinutes"]
    new_t = full["kpi"]["weightedTardinessMinutes"]
    ref_c = ref["kpi"]["cMaxMinutes"]
    new_c = full["kpi"]["cMaxMinutes"]
    if ref_t > 0:
        assert new_t <= ref_t * 0.95, \
            "weightedTardiness no improvement: ref=%s new=%s" % (ref_t, new_t)
    else:
        assert new_t == 0
    assert new_c <= ref_c * 1.02, \
        "cMax regressed: ref=%s new=%s" % (ref_c, new_c)


def test_medium_instance_time_and_feasibility():
    """中型（~150 工序）：10s 限时连跑 3 次，全部可行且不超时。"""
    data = synth_instance(40, 10, seed=20261008)
    data["algorithm"]["populationSize"] = 100
    data["algorithm"]["maxGenerations"] = 100000
    data["algorithm"]["timeLimitSeconds"] = 10
    n_ops = sum(len(o["operations"]) for o in data["orders"])
    assert 100 <= n_ops <= 300, "medium instance op count out of range: %d" % n_ops

    durations = []
    for run in range(3):
        t0 = time.monotonic()
        resp = _solve(data)
        elapsed = time.monotonic() - t0
        durations.append(elapsed)
        assert elapsed <= 12.0, "run %d exceeded limit+buffer: %.1fs" % (run, elapsed)
        assert resp["feasibleSolution"], resp["constraintCheck"]["conflicts"][:3]
        assert resp["status"] in ("SUCCESS", "TIME_LIMIT")
    p50 = statistics.median(durations)
    p95 = max(durations)
    print("\nmedium instance: ops=%d durations=%s P50=%.2fs P95=%.2fs"
          % (n_ops, ["%.2f" % d for d in durations], p50, p95))
    assert p95 <= 12.0


@pytest.mark.slow
def test_large_instance_under_time_limit():
    """大型（~600 工序）：请求超大种群验证动态截断，15s 限时内结束且可行。"""
    data = synth_instance(150, 15, seed=20261008, work_days=10)
    data["algorithm"]["populationSize"] = 2000
    data["algorithm"]["maxGenerations"] = 100000
    data["algorithm"]["timeLimitSeconds"] = 15
    n_ops = sum(len(o["operations"]) for o in data["orders"])
    assert n_ops >= 500, "large instance op count out of range: %d" % n_ops

    t0 = time.monotonic()
    resp = _solve(data)
    elapsed = time.monotonic() - t0
    assert elapsed <= 17.0, "exceeded limit+buffer: %.1fs" % elapsed
    assert resp["status"] in ("SUCCESS", "TIME_LIMIT")
    assert resp["feasibleSolution"], resp["constraintCheck"]["conflicts"][:3]
    timings = resp["meta"]["timings"]
    assert timings["initPopulationMs"] <= 15_000
    print("\nlarge instance: ops=%d elapsed=%.2fs termination=%s kpi=%s"
          % (n_ops, elapsed, resp["meta"]["terminationReason"],
             {k: resp["kpi"][k] for k in ("cMaxMinutes", "weightedTardinessMinutes")}))


def test_local_reschedule_less_change_than_full():
    """同一扰动下，局部重调度的变更量（机器变更数/受影响工序数）应不大于完全重调度。"""
    base_data = synth_instance(15, 6, seed=20261008)
    base_data["algorithm"]["populationSize"] = 60
    base_data["algorithm"]["maxGenerations"] = 100
    base_data["algorithm"]["timeLimitSeconds"] = 10
    base = _solve(base_data)
    assert base["feasibleSolution"]

    old_plan = _old_plan(base)
    # 扰动：前两个订单的全部工序受影响
    affected = [op["operationId"]
                for op in base["operations"]
                if op["operationId"].startswith(("O0001-", "O0002-"))]
    assert affected

    def reschedule(mode):
        data = json.loads(json.dumps(base_data))
        data["mode"] = mode
        data["oldPlan"] = old_plan
        data["affectedOperationIds"] = affected
        data["lockings"] = []
        data["objectiveWeights"] = {"makespan": 0.3, "weightedTardiness": 0.4,
                                    "deltaPlan": 0.2, "machineChange": 0.1}
        return _solve(data)

    local = reschedule("LOCAL_RESCHEDULE")
    full = reschedule("FULL_RESCHEDULE")
    assert local["feasibleSolution"] and full["feasibleSolution"]

    local_delta = local["kpi"]["deltaPlan"]
    full_delta = full["kpi"]["deltaPlan"]
    assert local_delta["nMachineChange"] <= full_delta["nMachineChange"]
    assert local_delta["startTimeShiftRate"] <= full_delta["startTimeShiftRate"] + 1e-9
    local_affected = sum(1 for op in local["operations"] if op["affected"])
    full_affected = sum(1 for op in full["operations"] if op["affected"])
    assert local_affected <= full_affected
    # 局部重调度的质量退化在容差内（不显著差于完全重调度）
    assert (local["kpi"]["weightedTardinessMinutes"]
            <= full["kpi"]["weightedTardinessMinutes"] * 1.5 + 1)
