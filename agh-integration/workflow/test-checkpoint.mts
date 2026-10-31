// workflow/test-checkpoint.mts — 检查点模型与存储测试（任务 3.1）。
// 覆盖：schema 字段全集、原子写/读、崩溃中断（半截 tmp 不损坏原检查点、主文件损坏
// 抛 CheckpointCorruptError 而非静默）、推进前写意图/推进后写结果、步骤重试复用幂等键、
// 触发源去重键重复触发返回同一 workflowId。
// 全程本地临时目录，无网络、无副作用。
// 运行：../agnes-harness/node_modules/.bin/tsx workflow/test-checkpoint.mts（cwd 为 agh-integration）
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore, CheckpointCorruptError, CHECKPOINT_VERSION } from './checkpoint.mts'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log('PASS ' + msg)
  else {
    failures++
    console.log('FAIL ' + msg)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fjsp-wf-checkpoint-'))
const store = new CheckpointStore(dir)

// ---- 1. 创建：schema 字段全集 + 落盘 + 读回一致 ----
const { checkpoint: cp1, deduplicated: dup1 } = store.create({
  type: 'DISTURBANCE',
  trigger: { source: 'mhs', dedupeKey: 'M-03|2026-09-17T06:00:00Z|BREAKDOWN', detail: { temperature: 85.2 } },
})
assert(dup1 === false, '创建：首次触发 deduplicated=false')
assert(cp1.version === CHECKPOINT_VERSION, '创建：version 字段')
assert(/^wf-[0-9a-f-]{36}$/.test(cp1.workflowId), `创建：workflowId 形态（${cp1.workflowId}）`)
assert(cp1.status === 'RUNNING', '创建：初始状态 RUNNING')
assert(cp1.trigger.source === 'mhs' && cp1.trigger.dedupeKey.includes('M-03'), '创建：触发源与去重键落盘')
assert(cp1.refs.eventId === null && cp1.refs.taskId === null && cp1.refs.planVersionId === null, '创建：业务对象 ID 初始为空')
assert(cp1.current === null && cp1.completedSteps.length === 0, '创建：无当前步骤/无已完成步骤')
assert(cp1.pendingApproval === null && cp1.expiredApprovals.length === 0, '创建：无待审批/无过期审批存档')
assert(typeof cp1.createdAt === 'string' && typeof cp1.updatedAt === 'string', '创建：createdAt/updatedAt 存在')
assert(existsSync(join(dir, `${cp1.workflowId}.json`)), '创建：检查点文件已落盘')
const roundtrip = store.load(cp1.workflowId)
assert(JSON.stringify(roundtrip) === JSON.stringify(cp1), '创建：读回与写入一致（JSON round-trip）')

// ---- 2. 去重键：同键重复触发返回同一 workflowId，不新建 ----
const again = store.create({ type: 'DISTURBANCE', trigger: { source: 'mhs', dedupeKey: 'M-03|2026-09-17T06:00:00Z|BREAKDOWN' } })
assert(again.deduplicated === true, '去重：同键重复触发 deduplicated=true')
assert(again.checkpoint.workflowId === cp1.workflowId, '去重：返回已有 workflowId 而不新建')
assert(readdirSync(dir).filter((f) => f.endsWith('.json')).length === 1, '去重：目录内仍只有 1 个检查点文件')
const other = store.create({ type: 'DISTURBANCE', trigger: { source: 'manual', dedupeKey: 'M-05|2026-09-18T01:00:00Z|BREAKDOWN' } })
assert(other.deduplicated === false && other.checkpoint.workflowId !== cp1.workflowId, '去重：不同键创建新工作流')

// ---- 3. 推进前写意图 / 推进后写结果 ----
store.beginStep(cp1.workflowId, 'register-event')
let cur = store.load(cp1.workflowId)!
assert(cur.current?.node === 'register-event' && cur.current.attempt === 1 && cur.current.phase === 'intent', '意图：beginStep 后当前步骤 phase=intent attempt=1')
const key1 = cur.current!.idempotencyKey
assert(key1 === `${cp1.workflowId}:register-event:1`, `意图：幂等键 = workflowId:node:seq（${key1}）`)

// 崩溃在 beginStep 之后、completeStep 之前 → 检查点留有"意图未定"痕迹（恢复协议据此查终态）
assert(cur.completedSteps.length === 0, '意图：崩溃中断时无完成记录（副作用未知）')

// 同节点再次 beginStep = 步骤内重试：attempt+1、幂等键不变
store.beginStep(cp1.workflowId, 'register-event')
cur = store.load(cp1.workflowId)!
assert(cur.current!.attempt === 2 && cur.current!.idempotencyKey === key1, '重试：attempt=2 且复用同一幂等键')

// 推进后写结果：业务证据落 completedSteps + refs
store.completeStep(cp1.workflowId, { eventId: 'EVT-100' }, { eventId: 'EVT-100' })
cur = store.load(cp1.workflowId)!
assert(cur.current === null, '结果：completeStep 后无当前步骤')
assert(cur.completedSteps.length === 1 && cur.completedSteps[0].node === 'register-event', '结果：步骤落入 completedSteps')
assert(cur.completedSteps[0].result?.eventId === 'EVT-100' && cur.completedSteps[0].attempt === 2, '结果：业务证据与最终尝试次数落盘')
assert(cur.refs.eventId === 'EVT-100', '结果：refs 合并 eventId')

// 再次进入同名节点 = 新一次执行：seq 递增、换新键（旧步骤已了结，换键不误伤服务端幂等）
store.beginStep(cp1.workflowId, 'register-event')
cur = store.load(cp1.workflowId)!
assert(cur.current!.seq === 2 && cur.current!.idempotencyKey === `${cp1.workflowId}:register-event:2`, '再进入：seq=2 新幂等键')

// 未 completeStep 就进入新节点 → 编程错误，必须拒绝（防止跳过"写结果"）
let threw = false
try {
  store.beginStep(cp1.workflowId, 'reschedule')
} catch {
  threw = true
}
assert(threw, '守卫：当前步骤未了结时进入新节点抛错')
store.completeStep(cp1.workflowId, { eventId: 'EVT-100' })
store.beginStep(cp1.workflowId, 'reschedule')
store.completeStep(cp1.workflowId, { taskId: 'TSK-100' }, { taskId: 'TSK-100' })

// ---- 4. 审批挂起 / 过期存档 ----
store.beginStep(cp1.workflowId, 'publish')
const approval = {
  requestId: 'req-1',
  tool: 'fjsp_publish',
  bizObject: 'PV-100',
  argsDigest: 'abc123',
  requiredRoles: ['PRODUCTION_MANAGER', 'ADMIN'],
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
}
store.recordApproval(cp1.workflowId, approval)
cur = store.load(cp1.workflowId)!
assert(cur.status === 'WAITING_APPROVAL' && cur.pendingApproval?.requestId === 'req-1', '审批：recordApproval 后 WAITING_APPROVAL + 五要素句柄落盘')
store.expireApproval(cp1.workflowId, '审批状态无法确认（测试）')
cur = store.load(cp1.workflowId)!
assert(cur.status === 'RUNNING' && cur.pendingApproval === null, '审批：expireApproval 后回到 RUNNING 且挂起清空')
assert(cur.expiredApprovals.length === 1 && cur.expiredApprovals[0].requestId === 'req-1' && typeof cur.expiredApprovals[0].expiredAt === 'string', '审批：旧审批进入 expiredApprovals 存档（不回放）')

// ---- 5. 原子写与崩溃中断 ----
// 5a. 目录里残留半截 tmp 文件（崩溃在 rename 之前）→ 原检查点读回完好
const wf2 = other.checkpoint.workflowId
writeFileSync(join(dir, `${wf2}.json.tmp-99999-1`), '{"workflowId":"wf-x","status":"RUN') // 半截 JSON
const intact = store.load(wf2)
assert(intact !== null && intact.workflowId === wf2 && intact.status === 'RUNNING', '原子写：半截 tmp 残渣不影响原检查点读回')
assert(readdirSync(dir).filter((f) => f.endsWith('.json')).length === 2, '原子写：list 口径只认 .json，tmp 不计数')
// 继续正常写入后 tmp 被正常清理（新写不残留 tmp）
store.beginStep(wf2, 'register-event')
store.completeStep(wf2, { eventId: 'EVT-200' }, { eventId: 'EVT-200' })
assert(readdirSync(dir).filter((f) => f.includes('.tmp') && !f.includes('tmp-99999')).length === 0, '原子写：正常写入不留 tmp 残渣')

// 5b. 主文件损坏 → 抛 CheckpointCorruptError，绝不静默采信垃圾内容
writeFileSync(join(dir, `${wf2}.json`), '{"workflowId": 破烂')
let corruptThrew = false
try {
  store.load(wf2)
} catch (e) {
  corruptThrew = e instanceof CheckpointCorruptError
}
assert(corruptThrew, '原子写：主文件损坏抛 CheckpointCorruptError（fail-loud）')

// 5c. 内容合法性：写入文件是格式化的完整 JSON（可被独立工具解析）
store.setStatus(cp1.workflowId, 'COMPLETED', '测试完成')
const raw = JSON.parse(readFileSync(join(dir, `${cp1.workflowId}.json`), 'utf8'))
assert(raw.status === 'COMPLETED' && raw.statusReason === '测试完成', '落盘：setStatus 终态与原因可读')

// ---- 收尾 ----
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS (test-checkpoint)' : `\n${failures} FAILURES (test-checkpoint)`)
process.exit(failures === 0 ? 0 : 1)
