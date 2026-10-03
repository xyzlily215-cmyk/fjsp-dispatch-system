import time
from typing import Dict, List

from fastapi import FastAPI

from . import ALGORITHM_VERSION, __version__
from .instance import build_problem
from .models import SolveRequest, ValidateRequest
from .solver import solve
from .timeutil import iso_to_minutes
from .validator import validate_plan

app = FastAPI(title="FJSP Algorithm Service", version=__version__)


@app.get("/health")
def health():
    return {"status": "UP", "version": __version__, "algorithmVersion": ALGORITHM_VERSION}


@app.post("/solve")
def solve_endpoint(req: SolveRequest):
    return solve(req)


@app.post("/validate")
def validate_endpoint(req: ValidateRequest):
    t0 = time.monotonic()
    conflicts: List[dict] = []
    problem = build_problem(req, conflicts)
    if problem is None:
        return {"passed": False, "conflicts": conflicts,
                "meta": {"elapsedMs": int((time.monotonic() - t0) * 1000)}}
    placements: Dict[str, tuple] = {}
    for p in req.operations:
        start = p.startAtMinutes
        if start is None and p.startAt is not None:
            start = iso_to_minutes(p.startAt, problem.sim_start)
        end = p.endAtMinutes
        if end is None and p.endAt is not None:
            end = iso_to_minutes(p.endAt, problem.sim_start)
        if start is None or end is None:
            conflicts.append({
                "rule": "E_VALIDATION",
                "objects": [p.operationId],
                "severity": "ERROR",
                "suggestion": "需要提供 startAt/endAt（ISO）或 startAtMinutes/endAtMinutes",
            })
            continue
        placements[p.operationId] = (p.machineId, start, end, p.changeoverMinutes)
    check_conflicts = validate_plan(problem, placements)
    all_conflicts = conflicts + check_conflicts
    passed = not any(c["severity"] == "ERROR" for c in all_conflicts)
    return {
        "passed": passed,
        "conflicts": all_conflicts,
        "meta": {"elapsedMs": int((time.monotonic() - t0) * 1000)},
    }
