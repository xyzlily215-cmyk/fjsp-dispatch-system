from app.instance import build_problem
from app.models import SolveRequest
from app.validator import validate_plan
from tests.conftest import tiny_request

FEASIBLE_PLAN = {
    "A1-10": ("M1", 0, 25, 0),
    "A1-20": ("M1", 25, 45, 0),
    "B1-10": ("M2", 0, 30, 0),
}


def _rules(conflicts):
    return sorted(c["rule"] for c in conflicts if c["severity"] == "ERROR")


def _validate(req_dict, plan):
    req = SolveRequest(**req_dict)
    conflicts = []
    problem = build_problem(req, conflicts)
    assert problem is not None
    return conflicts + validate_plan(problem, plan)


def test_feasible_plan_passes():
    conflicts = _validate(tiny_request(), dict(FEASIBLE_PLAN))
    assert _rules(conflicts) == []


def test_machine_overlap_detected():
    plan = dict(FEASIBLE_PLAN)
    plan["A1-20"] = ("M1", 20, 40, 0)
    conflicts = _validate(tiny_request(), plan)
    assert "MACHINE_OVERLAP" in _rules(conflicts)


def test_availability_violation_detected():
    plan = dict(FEASIBLE_PLAN)
    plan["B1-10"] = ("M2", 470, 495, 0)
    conflicts = _validate(tiny_request(), plan)
    assert "AVAILABILITY_VIOLATION" in _rules(conflicts)


def test_precedence_violation_detected():
    plan = {
        "A1-10": ("M1", 30, 55, 0),
        "A1-20": ("M2", 0, 15, 0),
        "B1-10": ("M2", 20, 50, 0),
    }
    conflicts = _validate(tiny_request(), plan)
    assert "PRECEDENCE_VIOLATION" in _rules(conflicts)


def test_release_violation_detected():
    req = tiny_request()
    req["orders"][0]["arrivalMinutes"] = 10
    conflicts = _validate(req, dict(FEASIBLE_PLAN))
    assert "RELEASE_VIOLATION" in _rules(conflicts)


def test_hard_lock_modification_detected():
    req = tiny_request(lockings=[{
        "operationId": "A1-10", "lockType": "completed",
        "machineId": "M1", "startAtMinutes": 0, "endAtMinutes": 25,
    }])
    plan = dict(FEASIBLE_PLAN)
    plan["A1-10"] = ("M1", 5, 30, 0)
    conflicts = _validate(req, plan)
    assert "HARD_LOCK_VIOLATION" in _rules(conflicts)


def test_changeover_violation_detected():
    plan = {
        "A1-10": ("M1", 0, 25, 0),
        "B1-10": ("M1", 25, 70, 0),   # F1 -> F2 requires 15 min changeover
        "A1-20": ("M2", 25, 40, 0),
    }
    conflicts = _validate(tiny_request(), plan)
    assert "CHANGEOVER_VIOLATION" in _rules(conflicts)


def test_changeover_correct_value_passes():
    plan = {
        "A1-10": ("M1", 0, 25, 0),
        "B1-10": ("M1", 40, 85, 15),  # 25 + 15 changeover
        "A1-20": ("M2", 25, 40, 0),
    }
    conflicts = _validate(tiny_request(), plan)
    assert _rules(conflicts) == []
