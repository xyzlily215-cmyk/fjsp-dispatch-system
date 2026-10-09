import logging
import threading
import time
from typing import Dict, List

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import ALGORITHM_VERSION, __version__
from .conflicts import make_conflict
from .instance import _resolve_minutes, build_problem
from .models import SolveRequest, SolveResponse, ValidateRequest, ValidateResponse
from .solver import solve
from .validator import validate_plan

# 项目无外部日志配置：进程尚未配置任何 handler 时给一份最简控制台配置；
# uvicorn 部署下 root logger 已有 handler，这里不重复设置
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="FJSP Algorithm Service", version=__version__)

logger = logging.getLogger(__name__)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # 未预期异常兜底：完整堆栈只进日志，响应不泄露内部细节。
    # 请求校验错误（422，RequestValidationError 走 FastAPI 默认处理器）和
    # 业务 INFEASIBLE（200 + conflicts，在 solve 内正常返回）都不经过这里。
    logger.exception("unhandled error: %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={
        "status": "ERROR",
        "conflicts": [make_conflict(
            "E_INTERNAL", [], "ERROR",
            "算法服务内部错误，请稍后重试或联系管理员")],
    })

# GA 是 CPU 密集型任务：同一进程内并发执行只会争用 GIL，使所有任务一起变慢。
# 串行化 /solve：并发请求在线程池中排队等待（不返回 503），业务侧任务保持 PENDING。
_solve_lock = threading.Lock()


@app.get("/health")
async def health():
    # async：即使线程池被等待 _solve_lock 的请求占满，健康检查仍在事件循环上响应
    return {"status": "UP", "version": __version__, "algorithmVersion": ALGORITHM_VERSION}


@app.post("/solve", response_model=SolveResponse)
def solve_endpoint(req: SolveRequest):
    logger.info("solve request: mode=%s machines=%d orders=%d ops=%d lockings=%d",
                req.mode, len(req.machines), len(req.orders),
                sum(len(o.operations) for o in req.orders),
                len(req.lockings or []))
    with _solve_lock:
        return solve(req)


@app.post("/validate", response_model=ValidateResponse)
def validate_endpoint(req: ValidateRequest):
    logger.info("validate request: machines=%d orders=%d ops=%d placements=%d",
                len(req.machines), len(req.orders),
                sum(len(o.operations) for o in req.orders), len(req.operations))
    t0 = time.monotonic()
    conflicts: List[dict] = []
    problem = build_problem(req, conflicts)
    if problem is None:
        return {"passed": False, "conflicts": conflicts,
                "meta": {"elapsedMs": int((time.monotonic() - t0) * 1000)}}
    placements: Dict[str, tuple] = {}
    for p in req.operations:
        start = _resolve_minutes(p.startAtMinutes, p.startAt, problem.sim_start,
                                 "startAt", p.operationId, conflicts)
        end = _resolve_minutes(p.endAtMinutes, p.endAt, problem.sim_start,
                               "endAt", p.operationId, conflicts)
        if start is None or end is None:
            conflicts.append(make_conflict(
                "E_VALIDATION", [p.operationId], "ERROR",
                "需要提供 startAt/endAt（ISO）或 startAtMinutes/endAtMinutes"))
            continue
        placements[p.operationId] = (p.machineId, start, end, p.changeoverMinutes)
    check_conflicts = validate_plan(problem, placements)
    all_conflicts = conflicts + check_conflicts
    passed = not any(c["severity"] == "ERROR" for c in all_conflicts)
    if not passed:
        logger.warning("validate failed: rules=%s",
                       sorted({c["rule"] for c in all_conflicts
                               if c["severity"] == "ERROR"}))
    return {
        "passed": passed,
        "conflicts": all_conflicts,
        "meta": {"elapsedMs": int((time.monotonic() - t0) * 1000)},
    }
