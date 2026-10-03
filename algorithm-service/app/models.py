from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator

MODE_BASELINE = "BASELINE"
MODE_LOCAL = "LOCAL_RESCHEDULE"
MODE_FULL = "FULL_RESCHEDULE"
MODES = (MODE_BASELINE, MODE_LOCAL, MODE_FULL)

HARD_LOCK_TYPES = ("completed", "in_progress", "frozen")


class CandidateIn(BaseModel):
    machineId: str
    processMinutes: int = Field(gt=0)
    setupMinutes: int = Field(ge=0)


class OperationIn(BaseModel):
    operationId: str
    seqNo: int = Field(ge=1)
    candidates: List[CandidateIn] = Field(min_length=1)


class OrderIn(BaseModel):
    orderId: str
    productFamily: str
    quantity: int = Field(gt=0)
    arrivalMinutes: int = Field(ge=0)
    dueMinutes: int = Field(ge=0)
    priority: int = Field(ge=1, le=5)
    operations: List[OperationIn] = Field(min_length=1)


class MachineIn(BaseModel):
    machineId: str
    workCenterId: str = ""
    productFamilies: List[str] = Field(default_factory=list)
    availableIntervals: List[List[int]] = Field(default_factory=list)

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
    startAtMinutes: Optional[int] = None
    endAtMinutes: Optional[int] = None
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    changeoverMinutes: int = Field(default=0, ge=0)


class LockingIn(BaseModel):
    operationId: str
    lockType: str  # completed | in_progress | frozen | soft
    machineId: Optional[str] = None
    startAtMinutes: Optional[int] = None
    endAtMinutes: Optional[int] = None
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    changeoverMinutes: int = Field(default=0, ge=0)
    softLocked: Optional[bool] = None


class AlgorithmParams(BaseModel):
    populationSize: int = Field(default=100, ge=2, le=2000)
    maxGenerations: int = Field(default=300, ge=1, le=100000)
    timeLimitSeconds: int = Field(default=60, ge=1, le=600)
    randomSeed: int = 20260916
    initMix: Optional[Dict[str, float]] = None  # keys: edd, spt, mwkr, random
    elitismRate: float = Field(default=0.05, ge=0.0, le=0.5)
    tournamentSize: int = Field(default=3, ge=2, le=10)
    crossoverRate: float = Field(default=0.9, ge=0.0, le=1.0)
    mutationRate: float = Field(default=0.2, ge=0.0, le=1.0)
    localSearchTrials: int = Field(default=25, ge=0, le=500)


class SolveRequest(BaseModel):
    mode: str
    simulationStartAt: datetime
    machines: List[MachineIn] = Field(min_length=1)
    orders: List[OrderIn] = Field(min_length=1)
    oldPlan: Optional[List[OldPlanOpIn]] = None
    lockings: Optional[List[LockingIn]] = None
    affectedOperationIds: Optional[List[str]] = None
    freezeWindowMinutes: Optional[int] = Field(default=None, ge=0)
    changeoverDefault: int = Field(default=20, ge=0)
    changeoverMatrix: Optional[Dict[str, int]] = None
    objectiveWeights: Dict[str, float] = Field(default_factory=dict)
    deltaPlanWeights: Optional[Dict[str, float]] = None
    algorithm: AlgorithmParams = Field(default_factory=AlgorithmParams)

    @field_validator("simulationStartAt")
    @classmethod
    def _check_tz(cls, v):
        if v.tzinfo is None:
            raise ValueError("simulationStartAt must carry a timezone offset")
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
    startAtMinutes: Optional[int] = None
    endAtMinutes: Optional[int] = None
    startAt: Optional[datetime] = None
    endAt: Optional[datetime] = None
    changeoverMinutes: int = Field(default=0, ge=0)


class ValidateRequest(BaseModel):
    simulationStartAt: datetime
    machines: List[MachineIn] = Field(min_length=1)
    orders: List[OrderIn] = Field(min_length=1)
    operations: List[PlannedOpIn] = Field(min_length=1)
    changeoverDefault: int = Field(default=20, ge=0)
    changeoverMatrix: Optional[Dict[str, int]] = None
    oldPlan: Optional[List[OldPlanOpIn]] = None
    lockings: Optional[List[LockingIn]] = None
    mode: Optional[str] = None
    affectedOperationIds: Optional[List[str]] = None
    freezeWindowMinutes: Optional[int] = Field(default=None, ge=0)

    @field_validator("simulationStartAt")
    @classmethod
    def _check_tz(cls, v):
        if v.tzinfo is None:
            raise ValueError("simulationStartAt must carry a timezone offset")
        return v
