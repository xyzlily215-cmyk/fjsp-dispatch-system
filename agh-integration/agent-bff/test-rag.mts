// test-rag: 任务 5.1 经验结果反馈 / 检索降权 / 情景字段测试。
// 全程临时目录（FJSP_EXPERIENCE_FILE 覆盖），不碰真实 ~/.agh/fjsp-experience.jsonl。
// rag.mts 有向量模型时走 hybrid（RRF 得分恒正，返回前 TOP_K 条），无模型时降级纯 BM25
// （只返回得分>0 的记录）；两条路径下记录数口径不同，故各小节重写夹具文件，
// 使每个查询的候选池只含本组对照记录，断言在两条路径下都成立。
// 运行：cd agh-integration/agent-bff && ../agnes-harness/node_modules/.bin/tsx test-rag.mts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import rag.mts 前设置：模块加载时读取 env 定经验库/向量缓存路径
const tmpDir = mkdtempSync(join(tmpdir(), 'fjsp-rag-'))
const expFile = join(tmpDir, 'experience.jsonl')
process.env.FJSP_EXPERIENCE_FILE = expFile
delete process.env.FJSP_RAG_NEGATIVE_POLICY

const TS = '2026-11-01T00:00:00Z' // 所有对照记录同 ts，排除时间衰减差异（单测时间衰减见 internals 断言）
const writeLines = (lines: unknown[]) => writeFileSync(expFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

// 降权对照组：A/B 检索文本（机床+故障描述）相同，仅模式/KPI/负荷不同，B 被驳回
const REC_A = { id: 'exp-a', ts: TS, eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE', machineId: 'M-05', resultStatus: 'FEASIBLE', kpiDiff: { weightedTardinessMinutes: 3 }, loadLevel: 'HIGH', note: 'M-05 主轴过热停机' }
const REC_B = { id: 'exp-b', ts: TS, eventType: 'BREAKDOWN', mode: 'FULL_RESCHEDULE', machineId: 'M-05', resultStatus: 'FEASIBLE', kpiDiff: { weightedTardinessMinutes: 8 }, loadLevel: 'LOW', note: 'M-05 主轴过热停机' }
const FB_B = { kind: 'feedback', experienceId: 'exp-b', outcome: 'rejected', feedbackAt: '2026-11-01T12:00:00Z', feedbackBy: 'reviewer-01', note: '评审驳回：扰动过大' }
// 情景加权对照组：C/D 文本相同，仅 loadLevel 不同，均无反馈
const REC_C = { id: 'exp-c', ts: TS, eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE', machineId: 'M-07', kpiDiff: { weightedTardinessMinutes: 4 }, loadLevel: 'HIGH', note: 'M-07 轴承损坏' }
const REC_D = { id: 'exp-d', ts: TS, eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE', machineId: 'M-07', kpiDiff: { weightedTardinessMinutes: 4 }, loadLevel: 'LOW', note: 'M-07 轴承损坏' }
// filter 兜底组：唯一匹配记录为负面 outcome
const REC_E = { id: 'exp-e', ts: TS, eventType: 'BREAKDOWN', mode: 'FULL_RESCHEDULE', machineId: 'M-09', kpiDiff: { weightedTardinessMinutes: 12 }, note: 'M-09 刀库卡死' }
const FB_E = { kind: 'feedback', experienceId: 'exp-e', outcome: 'failed', feedbackAt: '2026-11-01T13:00:00Z', note: '发布后发现不可行' }
// 推荐排除组：唯一 NEW_ORDER 记录为负面 outcome
const REC_F = { id: 'exp-f', ts: TS, eventType: 'NEW_ORDER', mode: 'FULL_RESCHEDULE', kpiDiff: { weightedTardinessMinutes: 20 }, dueUrgency: 'HIGH', note: '紧急插单壳体C' }
const FB_F = { kind: 'feedback', experienceId: 'exp-f', outcome: 'reworked', feedbackAt: '2026-11-01T14:00:00Z', feedbackBy: 'reviewer-02' }

let failures = 0
const assert = (cond: unknown, msg: string) => {
  if (cond) console.log('PASS ' + msg)
  else {
    failures++
    console.log('FAIL ' + msg)
  }
}

const { experienceQuery, __ragInternals } = await import('./rag.mts')
const { OUTCOME_WEIGHT, QUALITY_HALF_LIFE_DAYS, CONTEXT_MATCH_BOOST, qualityOf, latestFeedbackById } = __ragInternals

// ---- 1. 质量分规则（显式、可测） ----
assert(OUTCOME_WEIGHT.success === 1.0 && OUTCOME_WEIGHT.partial === 0.7 && OUTCOME_WEIGHT.reworked === 0.4 && OUTCOME_WEIGHT.failed === 0.3 && OUTCOME_WEIGHT.rejected === 0.2, 'outcome 权重表：success 1.0 / partial 0.7 / reworked 0.4 / failed 0.3 / rejected 0.2')
{
  const halfLifeAgo = new Date(Date.now() - QUALITY_HALF_LIFE_DAYS * 86_400_000).toISOString()
  const q = qualityOf({ ts: halfLifeAgo }, null)
  assert(Math.abs(q - 0.5) < 0.01, `时间衰减：一个半衰期（${QUALITY_HALF_LIFE_DAYS} 天）后 quality≈0.5（实际 ${q.toFixed(3)}）`)
  const qr = qualityOf({ ts: TS }, 'rejected')
  assert(qr < 0.21 && qr > 0.19, '负面 outcome 权重生效（rejected≈0.2）')
  assert(qualityOf({}, null) === 1.0, '无 ts 无反馈的旧记录 quality=1.0（不受罚）')
}

// ---- 2. 旧格式兼容 + feedback 行不计入经验 ----
writeLines([
  // 旧格式记录：无 id、无 kind、无情景字段（任务 5.1 之前的历史数据形态）
  { ts: TS, eventType: 'BREAKDOWN', mode: 'LOCAL_RESCHEDULE', machineId: 'M-01', resultStatus: 'FEASIBLE', kpiDiff: { weightedTardinessMinutes: 5 }, published: true, note: '旧格式记录 主轴故障' },
  REC_A, REC_B, FB_B,
])
{
  const r = await experienceQuery({})
  assert(r.ok === true && r.retrieval === 'recency', '无 query 保持时间倒序（retrieval=recency）')
  assert(r.total === 3, `total 只计经验记录（3 条），feedback 行不计入（实际 ${r.total}）`)
  assert(r.records.every((x: { kind?: string }) => x.kind !== 'feedback'), 'records 不含 feedback 行')
  const old = r.records.find((x: { machineId?: string }) => x.machineId === 'M-01')
  assert(old && old.effectiveOutcome === null && old.quality > 0.9, '旧格式记录（无 id）正常读取：effectiveOutcome=null、quality≈1')
  const b = r.records.find((x: { id?: string }) => x.id === 'exp-b')
  assert(b && b.effectiveOutcome === 'rejected', '反馈按 experienceId 关联到原记录（exp-b effectiveOutcome=rejected）')
}

// ---- 3. 负面 outcome 降权（默认 downweight：压底但保留兜底） ----
writeLines([REC_A, REC_B, FB_B])
{
  const r = await experienceQuery({ query: 'M-05 主轴过热停机' })
  assert(r.matched === 2, `两条 M-05 记录都保留（默认降权不过滤，实际 matched=${r.matched}）`)
  assert(r.records[0].id === 'exp-a', '被驳回的 exp-b 被降权，exp-a 排前')
  const a = r.records.find((x: { id?: string }) => x.id === 'exp-a')
  const b = r.records.find((x: { id?: string }) => x.id === 'exp-b')
  assert(a.score > b.score, `降权后 exp-a 得分（${a.score}）> exp-b（${b.score}）`)
  assert(b.effectiveOutcome === 'rejected' && b.quality <= 0.21, 'exp-b 质量分 ≈0.2（rejected 权重 × 近零衰减）')
}

// ---- 4. 情景字段加权（loadLevel 同类场景加分） ----
writeLines([REC_C, REC_D])
{
  const boosted = await experienceQuery({ query: 'M-07 轴承损坏', loadLevel: 'HIGH' })
  assert(boosted.records[0].id === 'exp-c', '传入 loadLevel=HIGH 时同负荷的 exp-c 排前')
  const c = boosted.records.find((x: { id?: string }) => x.id === 'exp-c')
  const d = boosted.records.find((x: { id?: string }) => x.id === 'exp-d')
  const ratio = c.score / d.score
  assert(Math.abs(ratio - CONTEXT_MATCH_BOOST) < 0.05, `情景加权比分 ≈${CONTEXT_MATCH_BOOST}（实际 ${ratio.toFixed(3)}）`)
  const neutral = await experienceQuery({ query: 'M-07 轴承损坏' })
  const cn = neutral.records.find((x: { id?: string }) => x.id === 'exp-c')
  const dn = neutral.records.find((x: { id?: string }) => x.id === 'exp-d')
  assert(Math.abs(cn.score - dn.score) / dn.score < 0.05, '不传情景字段时 exp-c/exp-d 得分相同（无加权）')
}

// ---- 5. filter 策略与空结果回落 ----
{
  process.env.FJSP_RAG_NEGATIVE_POLICY = 'filter'
  writeLines([REC_A, REC_B, FB_B])
  const filtered = await experienceQuery({ query: 'M-05 主轴过热停机' })
  assert(filtered.matched === 1 && filtered.records[0].id === 'exp-a', 'filter 策略剔除被驳回的 exp-b')
  // 候选池全部负面：filter 后为空 → 回落降权，不返回空（兜底语义不变）
  writeLines([REC_E, FB_E])
  const fallback = await experienceQuery({ query: 'M-09 刀库卡死' })
  assert(fallback.matched === 1 && fallback.records[0].id === 'exp-e', 'filter 下候选池全部负面时回落降权，不返回空（兜底语义不变）')
  delete process.env.FJSP_RAG_NEGATIVE_POLICY
}

// ---- 6. 推荐统计排除负面 outcome ----
writeLines([REC_A, REC_B, FB_B, REC_F, FB_F])
{
  const r = await experienceQuery({ query: 'M-05 主轴过热停机' })
  assert(r.recommendation && r.recommendation.mode === 'LOCAL_RESCHEDULE', '推荐排除被驳回的 FULL 记录，推荐 LOCAL')
  const f = await experienceQuery({ eventType: 'NEW_ORDER' })
  assert(f.recommendation === null, '唯一同类记录被返工（reworked）时推荐为 null，不凭负面 KPI 推荐模式')
}

// ---- 7. 默认策略空查询词不报错 ----
{
  const r = await experienceQuery({ query: '不存在的情景词zqx' })
  assert(r.ok === true, '无匹配查询正常返回 ok=true')
}

// ---- 8. 反馈合并取最新 ----
{
  const fb = latestFeedbackById([
    { id: 'x', ts: TS },
    { kind: 'feedback', experienceId: 'x', outcome: 'failed', feedbackAt: '2026-11-01T10:00:00Z' },
    { kind: 'feedback', experienceId: 'x', outcome: 'reworked', feedbackAt: '2026-11-01T11:00:00Z' },
  ] as never)
  assert(fb.get('x')?.outcome === 'reworked', '同一经验多条反馈取 feedbackAt 最新一条')
}

rmSync(tmpDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部 RAG 降权/反馈/情景测试通过')
