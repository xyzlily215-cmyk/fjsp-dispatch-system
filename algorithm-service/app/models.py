from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

MODE_BASELINE = "BASELINE"
MODE_LOCAL = "LOCAL_RESCHEDULE"
MODE_FULL = "FULL_RESCHEDULE"
MODES = (MODE_BASELINE, MODE_LOCAL, MODE_FULL)

HARD_LOCK_TYPES = ("completed", "in_progress", "frozen")

# 请求规模上限。demo_instance.json 为 8 设备/20 订单/76 工序，这里取约 25 倍以上
# 余量：在 GA 自身的评估预算（ga.POP_EVAL_BUDGET）生效之前，挡住会耗尽内存或
# 让单次请求长时间独占求解锁的畸形大请求。总工序数跨订单求和，由模型级校验兜底。
MAX_MACHINES = 500
MAX_ORDERS = 2000
MAX_OPERATIONS_PER_ORDER = 200
MAX_CANDIDATES_PER_OP = MAX_MACHINES  # 候选设备不可能多于设备总数
MAX_TOTAL_OPERATIONS = 20000
MAX_INTERVALS_PER_MACHINE = 1000
MAX_FAMILIES_PER_MACHINE = 200


class CandidateIn(BaseModel):
    machineId: str
    processMinutes: int = Field(gt=0)
    setupMinutes: int = Field(ge=0)


class OperationIn(BaseModel):
    operationId: str
    seqNo: int = Field(ge=1)
    candidates: List[CandidateIn] = Field(min_length=1, max_length=MAX_CANDIDATES_PER_OP)


class OrderIn(BaseModel):
    orderId: str
    productFamily: str
    quantity: int = Field(gt=0)
    arrivalMinutes: int = Field(ge=0)
    dueMinutes: int = Field(ge=0)
    priority: int = Field(ge=1, le=5)
    operations: List[OperationIn] = Field(min_length=1, max_length=MAX_OPERATIONS_PER_ORDER)


class MachineIn(BaseModel):
    machineId: str
    workCenterId: str = ""
    productFamilies: List[str] = Field(default_factory=list, max_length=MAX_FAMILIES_PER_MACHINE)
    availableIntervals: List[List[int]] = Field(default_factory=list, max_length=MAX_INTERVALS_PER_MACHINE)

    @field_validator("availableIntervals")
    @classmethod
    def _check_intervals(cls, v):
        for iv in v:
            if len(iv) != 2:
                raise ValueError("availableIntervals items must be [startMin, endMin]")
            if iv[1] <= iv[0]:
                raise ValueError("interval endMin must be greater than startMin")
        return v


class OldPlanOpIn(BaseModel):
    operationId: str
    machineId: str
    startAtMinutes: Optional[int] = Field(default=None, ge=0)
    endAtMinutes: Optional[int] = Field(default=None, ge=0)
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    changeoverMinutes: int = Field(default=0, ge=0)


class LockingIn(BaseModel):
    operationId: str
    lockType: str  # completed | in_progress | frozen | soft
    machineId: Optional[str] = None
    startAtMinutes: Optional[int] = Field(default=None, ge=0)
    endAtMinutes: Optional[int] = Field(default=None, ge=0)
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    # in_progress 专用：实际开工时间（分钟）。实际开工是事实，锁定窗口以此为锚
    actualStartAtMinutes: Optional[int] = None
    changeoverMinutes: int = Field(default=0, ge=0)
    softLocked: Optional[bool] = None


class AlgorithmParams(BaseModel):
    populationSize: int = Field(default=100, ge=2, le=2000)
    maxGenerations: int = Field(default=300, ge=1, le=100000)
    timeLimitSeconds: int = Field(default=60, ge=1, le=600)
    randomSeed: int = 20260916
    initMix: Optional[Dict[str, float]] = Field(default=None, max_length=4)  # keys: edd, spt, mwkr, random
    elitismRate: float = Field(default=0.05, ge=0.0, le=0.5)
    tournamentSize: int = Field(default=3, ge=2, le=10)
    crossoverRate: float = Field(default=0.9, ge=0.0, le=1.0)
    mutationRate: float = Field(default=0.2, ge=0.0, le=1.0)
    localSearchTrials: int = Field(default=25, ge=0, le=500)

    @field_validator("initMix")
    @classmethod
    def _check_init_mix(cls, v):
        if v is None:
            return v
        total = 0.0
        for k, val in v.items():
            if not (0.0 <= val <= 1.0):
                raise ValueError("initMix.%s 必须在 [0,1] 内" % k)
            total += val
        if total > 1.0 + 1e-9:
            raise ValueError("initMix 各键总和不能超过 1")
        return v


class BaseSchedulingRequest(BaseModel):
    simulationStartAt: datetime
    machines: List[MachineIn] = Field(min_length=1, max_length=MAX_MACHINES)
    orders: List[OrderIn] = Field(min_length=1, max_length=MAX_ORDERS)
    oldPlan: Optional[List[OldPlanOpIn]] = Field(default=None, max_length=MAX_TOTAL_OPERATIONS)
    lockings: Optional[List[LockingIn]] = Field(default=None, max_length=MAX_TOTAL_OPERATIONS)
    affectedOperationIds: Optional[List[str]] = Field(default=None, max_length=MAX_TOTAL_OPERATIONS)
    freezeWindowMinutes: Optional[int] = Field(default=None, ge=0)
    changeoverDefault: int = Field(default=20, ge=0)
    changeoverMatrix: Optional[Dict[str, int]] = Field(default=None, max_length=10000)

    @field_validator("changeoverMatrix")
    @classmethod
    def _check_changeover_matrix(cls, v):
        if v is not None:
            for k, val in v.items():
                if val < 0:
                    raise ValueError("changeoverMatrix.%s 不能为负" % k)
        return v

    @field_validator("simulationStartAt")
    @classmethod
    def _check_tz(cls, v):
        if v.tzinfo is None:
            raise ValueError("simulationStartAt must carry a timezone offset")
        return v

    @model_validator(mode="after")
    def _check_total_operations(self):
        # 订单数 x 单订单工序数的乘积上限太松（2000x200），这里卡总量
        total = sum(len(o.operations) for o in self.orders)
        if total > MAX_TOTAL_OPERATIONS:
            raise ValueError("工序总数 %d 超过上限 %d" % (total, MAX_TOTAL_OPERATIONS))
        return self


class SolveRequest(BaseSchedulingRequest):
    mode: str
    objectiveWeights: Dict[str, float] = Field(default_factory=dict, max_length=16)
    deltaPlanWeights: Optional[Dict[str, float]] = Field(default=None, max_length=16)
    algorithm: AlgorithmParams = Field(default_factory=AlgorithmParams)

    @field_validator("objectiveWeights")
    @classmethod
    def _check_objective_weights(cls, v):
        # 负权重会让 GA 朝"更差"的方向优化，属于调用方配错，直接拒绝
        for k, val in v.items():
            if val < 0:
                raise ValueError("objectiveWeights.%s 不能为负" % k)
        return v

    @field_validator("deltaPlanWeights")
    @classmethod
    def _check_delta_weights(cls, v):
        if v is not None:
            for k, val in v.items():
                if val < 0:
                    raise ValueError("deltaPlanWeights.%s 不能为负" % k)
        return v

    @field_validator("mode")
    @classmethod
    def _check_mode(cls, v):
        if v not in MODES:
            raise ValueError("mode must be one of %s" % (",".join(MODES)))
        return v


class PlannedOpIn(BaseModel):
    operationId: str
    machineId: str
    startAtMinutes: Optional[int] = Field(default=None, ge=0)
    endAtMinutes: Optional[int] = Field(default=None, ge=0)
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    changeoverMinutes: int = Field(default=0, ge=0)


class ValidateRequest(BaseSchedulingRequest):
    operations: List[PlannedOpIn] = Field(min_length=1, max_length=MAX_TOTAL_OPERATIONS)
    mode: Optional[str] = None

    @field_validator("mode")
    @classmethod
    def _check_mode(cls, v):
        # mode 在 /validate 中是可选的（缺省按基线规则校验），
        # 但一旦给出就必须是合法模式，与 SolveRequest 保持一致
        if v is not None and v not in MODES:
            raise ValueError("mode must be one of %s" % (",".join(MODES)))
        return v


# ---------------- 响应模型 ----------------
# /solve 与 /validate 的响应是跨服务契约（business-service 依赖这些字段名），
# 这里只做形式化：字段名/结构与 solver.solve、api.validate_endpoint 现有产出
# 一一对应，不改变任何线上行为。


class ConflictOut(BaseModel):
    # 与 conflicts.make_conflict 产出的结构一致
    rule: str
    objects: List[str]
    severity: str
    suggestion: str


class OperationOut(BaseModel):
    operationId: str
    machineId: str
    setupStartAt: str
    setupStartAtMinutes: int
    processStartAt: str
    processStartAtMinutes: int
    startAt: str
    startAtMinutes: int
    endAt: str
    endAtMinutes: int
    changeoverMinutes: int
    frozen: bool
    affected: bool
    reasonCode: Optional[str] = None


class DeltaPlanKpiOut(BaseModel):
    startTimeShiftRate: float
    machineChangeRate: float
    sequenceChangeRate: float
    deltaPlan: float
    nMachineChange: int
    weights: Dict[str, float]


class KpiOut(BaseModel):
    cMaxMinutes: int
    weightedTardinessMinutes: int
    nTardy: int
    utilizationByMachine: Dict[str, float]
    loadImbalance: float
    deltaPlan: Optional[DeltaPlanKpiOut] = None


class ConstraintCheckOut(BaseModel):
    passed: bool
    conflicts: List[ConflictOut]


class SolveMetaOut(BaseModel):
    generations: int
    elapsedMs: int
    seed: int
    algorithmVersion: str
    terminationReason: Optional[str] = None
    # 停滞扰动（随机移民）触发次数；补充字段，不改变 terminationReason 语义
    stagnationRestarts: Optional[int] = None
    # 计时项随求解路径增减（buildProblemMs / 各 GA 阶段 / validateMs），
    # 键集合不固定，保留开放字典
    timings: Optional[Dict[str, int]] = None


class SolveResponse(BaseModel):
    status: str        # SUCCESS | TIME_LIMIT | INFEASIBLE
    resultStatus: str  # FEASIBLE | INFEASIBLE
    feasibleSolution: bool
    operations: List[OperationOut]
    kpi: Optional[KpiOut]
    constraintCheck: ConstraintCheckOut
    meta: SolveMetaOut


class ValidateMetaOut(BaseModel):
    elapsedMs: int


class ValidateResponse(BaseModel):
    passed: bool
    conflicts: List[ConflictOut]
    meta: ValidateMetaOut
