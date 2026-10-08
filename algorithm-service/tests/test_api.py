from fastapi.testclient import TestClient

from app.api import app
from tests.conftest import tiny_request

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "UP"


def test_solve_endpoint_and_validate_roundtrip():
    r = client.post("/solve", json=tiny_request())
    assert r.status_code == 200
    body = r.json()
    assert body["feasibleSolution"]
    assert body["constraintCheck"]["passed"]
    assert body["kpi"]["cMaxMinutes"] > 0

    plan_ops = [{
        "operationId": op["operationId"],
        "machineId": op["machineId"],
        "startAt": op["startAt"],
        "endAt": op["endAt"],
        "changeoverMinutes": op["changeoverMinutes"],
    } for op in body["operations"]]
    vreq = tiny_request()
    vreq.pop("objectiveWeights")
    vreq.pop("algorithm")
    vreq.pop("mode")
    vreq["operations"] = plan_ops
    rv = client.post("/validate", json=vreq)
    assert rv.status_code == 200
    vbody = rv.json()
    assert vbody["passed"], vbody["conflicts"]


def test_solve_infeasible_unknown_machine():
    req = tiny_request()
    req["orders"][0]["operations"][0]["candidates"] = [
        {"machineId": "M-XX", "setupMinutes": 5, "processMinutes": 20}
    ]
    r = client.post("/solve", json=req)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "INFEASIBLE"
    rules = [c["rule"] for c in body["constraintCheck"]["conflicts"]]
    assert "UNKNOWN_MACHINE" in rules or "NO_CANDIDATE_MACHINE" in rules


def test_unexpected_error_returns_structured_500(monkeypatch):
    from app import api

    def boom(req):
        raise RuntimeError("synthetic failure detail")

    monkeypatch.setattr(api, "solve", boom)
    # raise_server_exceptions=False：Starlette 处理完 Exception 后仍会向外重抛，
    # 这里只关心返回给客户端的响应
    safe_client = TestClient(app, raise_server_exceptions=False)
    r = safe_client.post("/solve", json=tiny_request())
    assert r.status_code == 500
    body = r.json()
    assert body["status"] == "ERROR"
    conflict = body["conflicts"][0]
    assert conflict["rule"] == "E_INTERNAL"
    assert conflict["severity"] == "ERROR"
    # 内部异常细节不进响应
    assert "synthetic failure detail" not in r.text


def test_request_size_limits_rejected():
    req = tiny_request()
    m = req["machines"][0]
    req["machines"] = [dict(m, machineId="M%d" % i) for i in range(501)]
    r = client.post("/solve", json=req)
    assert r.status_code == 422

    req = tiny_request()
    op = req["orders"][0]["operations"][0]
    req["orders"][0]["operations"] = [dict(op, operationId="X%d" % i,
                                           seqNo=i + 1) for i in range(201)]
    r = client.post("/solve", json=req)
    assert r.status_code == 422
