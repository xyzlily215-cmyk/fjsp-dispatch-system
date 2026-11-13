// workflow/checkpoint.mts — 工作流检查点模型与本地 JSON 文件存储（任务 3.1）。
//
// 设计依据：docs/Agent化架构优化方案.md 3.5「工作流实例与恢复协议」。
// 状态分裂防线：业务状态（事件/任务/计划）一律以 business-service 为准，
// 检查点只保存流程进度（走到哪一步、试了几次、用什么幂等键、等哪个审批），
// 崩溃重启后由 recovery.mts 读业务现态重建执行位置。
//
// 持久化时机（每次推进两段写）：
//   1. beginStep    —— 推进前写「意图」：进入节点、尝试次数+1、固定本步骤幂等键。
//                      崩溃后看到 phase=intent 即"该步骤副作用未知"，恢复时先查终态。
//   2. completeStep —— 推进后写「结果」：步骤产出（eventId/taskId/planVersionId 等
//                      业务证据）落入 completedSteps，供恢复时核对副作用是否已发生。
//
// 存储：本地 JSON 文件目录（默认 ~/.agh/fjsp-workflows/，FJSP_WORKFLOW_DIR 可覆盖），
// 单实例、原子写（tmp + rename + fsync）。每个工作流一个文件 wf-<uuid>.json。
import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CHECKPOINT_VERSION = 1

// 状态机：RUNNING 推进中；WAITING_APPROVAL 挂起等人工审批；COMPLETED 正常终态；
// FAILED 步骤重试耗尽/不可自动恢复（转人工）；TERMINATED 恢复核对发现业务现态
// 与检查点矛盾且不可调和，主动终止（不回放、不继续）。
export type WorkflowStatus = 'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'TERMINATED'

export interface TriggerInfo {
  source: string // 触发源：manual / mhs / api ...
  dedupeKey: string // 触发源去重键（如事件指纹 machineId+occurredAt+type）
  detail?: unknown // 触发上下文快照（告警原文等），仅存档不参与判定
}

export interface BusinessRefs {
  eventId: string | null
  taskId: string | null
  planVersionId: string | null
}

// 当前步骤（推进前写入的意图）。副作用是否已发生不在此记录——恢复时查业务现态。
export interface StepState {
  node: string
  seq: number // 本工作流内第几次进入该节点（从 1 计），幂等键的组成部分
  attempt: number // 本次进入的尝试次数（重试递增）
  idempotencyKey: string // 本次步骤执行的幂等键：wfId:node:seq，重试必须复用（任务 2.B 约定）
  phase: 'intent' // 目前只有 intent（已写意图、未确认结果）；结果由 completeStep 落 completedSteps
  startedAt: string
  updatedAt: string
}

export interface CompletedStep {
  node: string
  seq: number
  attempt: number
  idempotencyKey: string
  result?: Record<string, unknown> // 步骤产出（业务证据：eventId/taskId/planVersionId 等）
  recovered?: boolean // true = 恢复时经业务现态核对确认"副作用已发生"，补登记而非真实执行
  completedAt: string
}

// 待审批请求（BFF 五要素审批的句柄，任务 1.2）。审批本身是 BFF 侧记录，
// 检查点只存 requestId 与截止时间用于恢复核对；旧批准一律不回放。
export interface PendingApproval {
  requestId: string
  tool: string
  bizObject: string | null
  argsDigest?: string
  requiredRoles?: string[]
  issuedAt: string
  expiresAt: string // ISO 时间；与 BFF 审批记录有效期（默认 5 分钟）对齐
}

export interface ExpiredApproval extends PendingApproval {
  expiredAt: string
  reason: string
}

export interface WorkflowCheckpoint {
  version: typeof CHECKPOINT_VERSION
  workflowId: string
  type: string // 流程类型（如 DISTURBANCE 扰动处置；具体流程在 3.2 起落地）
  status: WorkflowStatus
  statusReason?: string
  trigger: TriggerInfo
  refs: BusinessRefs
  current: StepState | null
  completedSteps: CompletedStep[]
  pendingApproval: PendingApproval | null
  expiredApprovals: ExpiredApproval[] // 过期/无法确认的审批存档（审计用，不回放）
  createdAt: string
  updatedAt: string
}

export class CheckpointCorruptError extends Error {
  path: string
  constructor(path: string, cause: unknown) {
    super(`检查点文件损坏，拒绝猜测其内容：${path}（${String(cause)}）`)
    this.name = 'CheckpointCorruptError'
    this.path = path
  }
}

const nowIso = () => new Date().toISOString()

export class CheckpointStore {
  readonly dir: string
  private tmpCounter = 0

  constructor(dir?: string) {
    this.dir = dir || process.env.FJSP_WORKFLOW_DIR || join(homedir(), '.agh', 'fjsp-workflows')
    mkdirSync(this.dir, { recursive: true })
  }

  private fileOf(workflowId: string): string {
    // workflowId 由本模块生成（wf-<uuid>）；仍做一次字符白名单防御路径穿越
    if (!/^wf-[A-Za-z0-9-]+$/.test(workflowId)) throw new Error(`非法 workflowId：${workflowId}`)
    return join(this.dir, `${workflowId}.json`)
  }

  // 原子写：写独立 tmp 文件 + fsync + rename。崩溃最多留下孤儿 tmp，
  // 原检查点文件要么完整旧版、要么完整新版，绝不出现半截 JSON。
  private write(cp: WorkflowCheckpoint): WorkflowCheckpoint {
    cp.updatedAt = nowIso()
    const file = this.fileOf(cp.workflowId)
    const tmp = `${file}.tmp-${process.pid}-${++this.tmpCounter}`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(cp, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    return cp
  }

  load(workflowId: string): WorkflowCheckpoint | null {
    const file = this.fileOf(workflowId)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as WorkflowCheckpoint
    } catch (e) {
      throw new CheckpointCorruptError(file, e)
    }
  }

  // 全部检查点（去重索引用；单实例量级小，直接扫目录）。tmp 残渣一律忽略。
  list(): WorkflowCheckpoint[] {
    const out: WorkflowCheckpoint[] = []
    for (const name of readdirSync(this.dir)) {
      if (!/^wf-[A-Za-z0-9-]+\.json$/.test(name)) continue
      const file = join(this.dir, name)
      try {
        out.push(JSON.parse(readFileSync(file, 'utf8')) as WorkflowCheckpoint)
      } catch (e) {
        throw new CheckpointCorruptError(file, e)
      }
    }
    return out
  }

  // 触发源去重（对齐 business-service 事件幂等 E_DUPLICATE 语义）：
  // 同 dedupeKey 的重复触发返回已有 workflowId，不新建工作流。
  findByDedupeKey(dedupeKey: string): WorkflowCheckpoint | null {
    return this.list().find((cp) => cp.trigger.dedupeKey === dedupeKey) || null
  }

  create(input: { type: string; trigger: TriggerInfo }): { checkpoint: WorkflowCheckpoint; deduplicated: boolean } {
    const existing = this.findByDedupeKey(input.trigger.dedupeKey)
    if (existing) return { checkpoint: existing, deduplicated: true }
    const cp: WorkflowCheckpoint = {
      version: CHECKPOINT_VERSION,
      workflowId: `wf-${crypto.randomUUID()}`,
      type: input.type,
      status: 'RUNNING',
      trigger: input.trigger,
      refs: { eventId: null, taskId: null, planVersionId: null },
      current: null,
      completedSteps: [],
      pendingApproval: null,
      expiredApprovals: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    return { checkpoint: this.write(cp), deduplicated: false }
  }

  // 推进前写意图。同一节点再次 beginStep = 步骤内重试：attempt+1、复用同一幂等键；
  // 进入新节点前必须先 completeStep 了结当前步骤，否则视为编程错误。
  beginStep(workflowId: string, node: string): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    if (cp.current && cp.current.node === node) {
      cp.current.attempt += 1
      cp.current.updatedAt = nowIso()
    } else {
      if (cp.current) throw new Error(`步骤 ${cp.current.node} 未 completeStep，不能进入 ${node}`)
      const seq = cp.completedSteps.filter((s) => s.node === node).length + 1
      const idempotencyKey = `${workflowId}:${node}:${seq}`
      if (idempotencyKey.length > 120) throw new Error(`幂等键超过 120 字符上限：${idempotencyKey}`)
      cp.current = { node, seq, attempt: 1, idempotencyKey, phase: 'intent', startedAt: nowIso(), updatedAt: nowIso() }
    }
    if (cp.status === 'WAITING_APPROVAL') cp.status = 'RUNNING'
    return this.write(cp)
  }

  // 推进后写结果：当前步骤了结为 completedSteps，业务证据（eventId 等）合并进 refs。
  completeStep(workflowId: string, result?: Record<string, unknown>, refs?: Partial<BusinessRefs>): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    if (!cp.current) throw new Error('没有进行中的步骤，不能 completeStep')
    const done: CompletedStep = {
      node: cp.current.node,
      seq: cp.current.seq,
      attempt: cp.current.attempt,
      idempotencyKey: cp.current.idempotencyKey,
      ...(result ? { result } : {}),
      completedAt: nowIso(),
    }
    cp.completedSteps.push(done)
    cp.current = null
    if (refs) Object.assign(cp.refs, refs)
    return this.write(cp)
  }

  // 恢复时补登记：业务现态核对确认副作用已发生，把当前步骤直接了结（不再执行）。
  markStepRecovered(workflowId: string, evidence?: Record<string, unknown>, refs?: Partial<BusinessRefs>): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    if (!cp.current) throw new Error('没有进行中的步骤，不能 markStepRecovered')
    cp.completedSteps.push({
      node: cp.current.node,
      seq: cp.current.seq,
      attempt: cp.current.attempt,
      idempotencyKey: cp.current.idempotencyKey,
      result: { recoveredFromBusinessState: true, ...(evidence || {}) },
      recovered: true,
      completedAt: nowIso(),
    })
    cp.current = null
    if (refs) Object.assign(cp.refs, refs)
    return this.write(cp)
  }

  // An authorization wait has not attempted the business operation. Keep the
  // stable step key without consuming its bounded execution retry budget.
  deferAttempt(workflowId: string): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    if (!cp.current) throw new Error('没有待授权步骤')
    cp.current.attempt = Math.max(0, cp.current.attempt - 1)
    return this.write(cp)
  }

  recordApproval(workflowId: string, approval: PendingApproval): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    cp.pendingApproval = approval
    cp.status = 'WAITING_APPROVAL'
    return this.write(cp)
  }

  // 审批已被裁决（批准/拒绝）：清除挂起。注意裁决结果本身不回放为业务副作用，
  // 是否已生效由恢复协议核对业务现态判定。
  clearApproval(workflowId: string): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    cp.pendingApproval = null
    if (cp.status === 'WAITING_APPROVAL') cp.status = 'RUNNING'
    return this.write(cp)
  }

  // 审批过期/无法确认有效：移入 expiredApprovals 存档，工作流回到 RUNNING 由
  // 恢复决策重新发起审批；旧批准不回放（方案 3.5）。
  expireApproval(workflowId: string, reason: string): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    if (!cp.pendingApproval) throw new Error('没有待审批请求，不能 expireApproval')
    cp.expiredApprovals.push({ ...cp.pendingApproval, expiredAt: nowIso(), reason })
    cp.pendingApproval = null
    if (cp.status === 'WAITING_APPROVAL') cp.status = 'RUNNING'
    return this.write(cp)
  }

  setStatus(workflowId: string, status: WorkflowStatus, reason?: string): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    cp.status = status
    if (reason !== undefined) cp.statusReason = reason
    return this.write(cp)
  }

  updateRefs(workflowId: string, refs: Partial<BusinessRefs>): WorkflowCheckpoint {
    const cp = this.mustLoad(workflowId)
    Object.assign(cp.refs, refs)
    return this.write(cp)
  }

  private mustLoad(workflowId: string): WorkflowCheckpoint {
    const cp = this.load(workflowId)
    if (!cp) throw new Error(`检查点不存在：${workflowId}`)
    return cp
  }
}
