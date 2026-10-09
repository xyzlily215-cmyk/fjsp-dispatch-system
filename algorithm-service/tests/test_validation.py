from fastapi.testclient import TestClient

from app.api import app
from conftest import tiny_request

client = TestClient(app)


def _validate_request(**over):
    req = tiny_request()
    for k in ("objectiveWeights", "algorithm", "mode"):
        req.pop(k, None)
    req["operations"] = [
        {"operationId": "A1-10", "machineId": "M1",
         "startAtMinutes": 0, "endAtMinutes": 25, "changeoverMinutes": 0},
        {"operationId": "A1-20", "machineId": "M1",
         "startAtMinutes": 25, "endAtMinutes": 45, "changeoverMinutes": 0},
        {"operationId": "B1-10", "machineId": "M2",
         "startAtMinutes": 0, "endAtMinutes": 45, "changeoverMinutes": 0},
    ]
    req.update(over)
    return req


def test_init_mix_negative_value_rejected():
    req = tiny_request()
    req["algorithm"]["initMix"] = {"edd": -0.1, "random": 0.5}
    r = client.post("/solve", json=req)
    assert r.status_code == 422


def test_init_mix_sum_over_one_rejected():
    req = tiny_request()
    req["algorithm"]["initMix"] = {"edd": 0.5, "spt": 0.3, "mwkr": 0.3}
    r = client.post("/solve", json=req)
    assert r.status_code == 422


def test_init_mix_valid_accepted():
    req = tiny_request()
    req["algorithm"]["initMix"] = {"edd": 0.5, "spt": 0.2, "mwkr": 0.1, "random": 0.2}
    r = client.post("/solve", json=req)
    assert r.status_code == 200
    assert r.json()["feasibleSolution"]


def test_delta_plan_weights_negative_rejected():
    req = tiny_request(mode="FULL_RESCHEDULE")
    req["oldPlan"] = [
        {"operationId": "A1-10", "machineId": "M1",
         "startAtMinutes": 0, "endAtMinutes": 25},
        {"operationId": "A1-20", "machineId": "M1",
         "startAtMinutes": 25, "endAtMinutes": 45},
        {"operationId": "B1-10", "machineId": "M2",
         "startAtMinutes": 0, "endAtMinutes": 45},
    ]
    req["deltaPlanWeights"] = {"startTimeShift": -0.5}
    r = client.post("/solve", json=req)
    assert r.status_code == 422


def test_validate_naive_datetime_returns_conflict_not_500():
    req = _validate_request()
    req["operations"][0] = {
        "operationId": "A1-10", "machineId": "M1",
        "startAt": "2026-09-16T08:00:00",  # naive: no timezone offset
        "endAtMinutes": 25, "changeoverMinutes": 0,
    }
    r = client.post("/validate", json=req)
    assert r.status_code == 200
    body = r.json()
    assert not body["passed"]
    assert any(c["rule"] == "E_VALIDATION" for c in body["conflicts"])


def test_solve_meta_reports_termination_reason():
    req = tiny_request()
    req["algorithm"]["localSearchTrials"] = 0
    r = client.post("/solve", json=req)
    assert r.status_code == 200
    reason = r.json()["meta"]["terminationReason"]
    assert reason in ("maxGenerations", "timeLimit", "localSearch")

    # tiny generation budget -> completes all generations, then local search
    req["algorithm"]["maxGenerations"] = 2
    req["algorithm"]["localSearchTrials"] = 3
    req["algorithm"]["timeLimitSeconds"] = 60
    r = client.post("/solve", json=req)
    assert r.json()["meta"]["terminationReason"] == "localSearch"


def test_objective_weights_negative_rejected():
    req = tiny_request()
    req["objectiveWeights"] = {"makespan": -0.1, "weightedTardiness": 0.4}
    r = client.post("/solve", json=req)
    assert r.status_code == 422


def test_validate_mode_invalid_rejected():
    r = client.post("/validate", json=_validate_request(mode="NOPE"))
    assert r.status_code == 422


def test_validate_mode_valid_accepted():
    r = client.post("/validate", json=_validate_request(mode="BASELINE"))
    assert r.status_code == 200


def test_validate_negative_planned_minutes_rejected():
    req = _validate_request()
    req["operations"][0]["startAtMinutes"] = -1
    r = client.post("/validate", json=req)
    assert r.status_code == 422

    req = _validate_request()
    req["operations"][0]["endAtMinutes"] = -1
    r = client.post("/validate", json=req)
    assert r.status_code == 422
