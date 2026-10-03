import json
import os
import subprocess
import sys
import time

from app.models import SolveRequest
from app.solver import solve

DEMO_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "demo_instance.json")


def _ensure_demo():
    if not os.path.exists(DEMO_PATH):
        script = os.path.join(os.path.dirname(DEMO_PATH), "scripts", "generate_demo.py")
        subprocess.run([sys.executable, script], check=True)


def test_demo_instance_solves_within_time_limit():
    _ensure_demo()
    with open(DEMO_PATH, encoding="utf-8") as f:
        data = json.load(f)
    # 防 CI 过慢：缩小种群与代数，时间上限 30s
    data["algorithm"]["populationSize"] = 40
    data["algorithm"]["maxGenerations"] = 60
    data["algorithm"]["timeLimitSeconds"] = 30
    t0 = time.monotonic()
    resp = solve(SolveRequest(**data))
    elapsed = time.monotonic() - t0
    assert elapsed < 60
    assert resp["feasibleSolution"], resp["constraintCheck"]["conflicts"][:3]
    assert resp["constraintCheck"]["passed"]
    assert resp["status"] in ("SUCCESS", "TIME_LIMIT")
    n_ops = sum(len(o["operations"]) for o in data["orders"])
    assert len(resp["operations"]) == n_ops
    assert resp["kpi"]["cMaxMinutes"] > 0
