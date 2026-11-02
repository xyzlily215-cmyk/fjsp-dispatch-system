// rag: 扰动处置经验库的语义检索（RAG）。
// 双路召回：multilingual-e5-small 向量检索（本地 ONNX，离线可跑）+ BM25 关键词检索，
// RRF 融合排序；向量模型不可用时自动降级为纯 BM25，无 query 时保持原有的时间倒序行为。
// 嵌入缓存到 ~/.agh/fjsp-experience-vectors.json，按 JSONL 行号增量更新。
// 任务 5.1（结果反馈 + 质量降权 + 情景字段）：
// - 经验记录向后兼容扩展：id、loadLevel、dueUrgency、repairDurationMinutes、orderQuantity；
//   结果反馈是独立的 kind=feedback 追加行（experienceId 关联），原始记录永不修改。
// - 质量分 quality = outcome 权重 × 时间衰减（半衰期 60 天）：success 1.0 / partial 0.7 /
//   reworked 0.4 / failed 0.3 / rejected 0.2；无反馈的记录权重 1.0（旧记录不受罚）。
// - 负面 outcome（rejected/reworked/failed）默认降权保留兜底；FJSP_RAG_NEGATIVE_POLICY=filter
//   时改为过滤，全部负面时回落降权（保证空结果回落语义不变）。
// - 查询可带 loadLevel/dueUrgency，同类负荷/紧迫度的记录各加权 ×1.2（情景相似度）。
// - 推荐统计剔除负面 outcome 的记录，不再仅凭历史平均 KPI 推荐模式。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

// FJSP_EXPERIENCE_FILE 覆盖（与 fjsp-tools 同一变量；测试用临时目录，绝不写真实经验库）；
// 覆盖经验库路径时向量缓存默认派生到同目录（<file>.vectors.json），可用
// FJSP_EXPERIENCE_VECTOR_CACHE 单独覆盖。
const EXPERIENCE_FILE = process.env.FJSP_EXPERIENCE_FILE || `${process.env.HOME}/.agh/fjsp-experience.jsonl`
const VECTOR_CACHE =
  process.env.FJSP_EXPERIENCE_VECTOR_CACHE ||
  (process.env.FJSP_EXPERIENCE_FILE ? `${EXPERIENCE_FILE}.vectors.json` : `${process.env.HOME}/.agh/fjsp-experience-vectors.json`)
const MODEL_DIR = new URL('./models/', import.meta.url).pathname
const MODEL_NAME = 'multilingual-e5-small'
const TOP_K = 5
const RRF_K = 60

// ---- 质量分与降权策略（规则显式、可测） ----
const OUTCOME_WEIGHT: Record<string, number> = { success: 1.0, partial: 0.7, reworked: 0.4, failed: 0.3, rejected: 0.2 }
const NEGATIVE_OUTCOMES = new Set(['rejected', 'reworked', 'failed'])
const QUALITY_HALF_LIFE_DAYS = 60
const CONTEXT_MATCH_BOOST = 1.2

type Outcome = 'success' | 'partial' | 'failed' | 'rejected' | 'reworked'

type ExperienceRecord = {
  id?: string
  ts?: string
  eventType?: string
  mode?: string
  machineId?: string
  resultStatus?: string
  kpiDiff?: { weightedTardinessMinutes?: number; deltaPlan?: number; cMaxMinutes?: number }
  published?: boolean
  note?: string
  loadLevel?: 'LOW' | 'NORMAL' | 'HIGH'
  dueUrgency?: 'LOW' | 'MEDIUM' | 'HIGH'
  repairDurationMinutes?: number
  orderQuantity?: number
  kind?: string // 'feedback' 为反馈行，其余/缺省为经验记录
}

type FeedbackRecord = {
  kind: 'feedback'
  experienceId: string
  outcome: Outcome
  feedbackAt?: string
  feedbackBy?: string
  note?: string
}

type ScoredRecord = ExperienceRecord & { score: number; scoreText: string; effectiveOutcome: Outcome | null; quality: number }

// ---------- 记录加载、反馈合并与质量分 ----------
function readExperience(): ExperienceRecord[] {
  try {
    return readFileSync(EXPERIENCE_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ExperienceRecord)
  } catch {
    return []
  }
}

// 反馈行按 experienceId 合并到原经验：同一经验多条反馈取 feedbackAt 最新一条
function latestFeedbackById(lines: ExperienceRecord[]): Map<string, FeedbackRecord> {
  const map = new Map<string, FeedbackRecord>()
  for (const l of lines) {
    if (l.kind !== 'feedback') continue
    const fb = l as unknown as FeedbackRecord
    if (!fb.experienceId) continue
    const prev = map.get(fb.experienceId)
    if (!prev || String(fb.feedbackAt ?? '') >= String(prev.feedbackAt ?? '')) map.set(fb.experienceId, fb)
  }
  return map
}

function effectiveOutcome(r: ExperienceRecord, feedback: Map<string, FeedbackRecord>): Outcome | null {
  return r.id ? (feedback.get(r.id)?.outcome ?? null) : null
}

// quality = outcome 权重 × 时间衰减（半衰期 QUALITY_HALF_LIFE_DAYS 天）；
// 无反馈 outcome=null → 权重 1.0（向后兼容：旧记录不因缺反馈受罚）；ts 缺失/非法 → 不衰减
function qualityOf(r: ExperienceRecord, outcome: Outcome | null, now = Date.now()): number {
  const w = outcome ? (OUTCOME_WEIGHT[outcome] ?? 1.0) : 1.0
  const t = r.ts ? Date.parse(r.ts) : NaN
  const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 0
  return w * Math.pow(0.5, ageDays / QUALITY_HALF_LIFE_DAYS)
}

function negativePolicy(): 'downweight' | 'filter' {
  return process.env.FJSP_RAG_NEGATIVE_POLICY === 'filter' ? 'filter' : 'downweight'
}

// 情景加权：同类负荷/紧迫度各 ×CONTEXT_MATCH_BOOST（仅在调用方传入对应字段时生效）
function contextBoost(r: ExperienceRecord, opts: { loadLevel?: string; dueUrgency?: string }): number {
  let b = 1
  if (opts.loadLevel && r.loadLevel === opts.loadLevel) b *= CONTEXT_MATCH_BOOST
  if (opts.dueUrgency && r.dueUrgency === opts.dueUrgency) b *= CONTEXT_MATCH_BOOST
  return b
}

// ---------- 检索文本 ----------
function searchText(r: ExperienceRecord): string {
  const typeText = r.eventType === 'BREAKDOWN' ? '设备故障停机维修' : r.eventType === 'NEW_ORDER' ? '紧急插单新订单' : ''
  const modeText = r.mode === 'LOCAL_RESCHEDULE' ? '局部重排' : r.mode === 'FULL_RESCHEDULE' ? '完全重排' : ''
  const kpi = r.kpiDiff?.weightedTardinessMinutes != null ? `加权拖期差值 ${r.kpiDiff.weightedTardinessMinutes}` : ''
  const loadText = r.loadLevel === 'HIGH' ? '高负荷时段' : r.loadLevel === 'LOW' ? '低负荷时段' : r.loadLevel === 'NORMAL' ? '负荷正常' : ''
  const urgencyText = r.dueUrgency === 'HIGH' ? '交期紧迫' : r.dueUrgency === 'MEDIUM' ? '交期中等' : r.dueUrgency === 'LOW' ? '交期宽松' : ''
  const scaleText =
    r.repairDurationMinutes != null ? `维修 ${r.repairDurationMinutes} 分钟` : r.orderQuantity != null ? `插单数量 ${r.orderQuantity}` : ''
  return [typeText, r.machineId ? `机床 ${r.machineId}` : '', modeText, r.resultStatus, kpi, loadText, urgencyText, scaleText, r.note ?? '']
    .filter(Boolean)
    .join('，')
}

// ---------- 向量路（e5-small，本地模型） ----------
type Embedder = (texts: string[]) => Promise<Float32Array[]>
let embedderPromise: Promise<Embedder> | null = null

function getEmbedder(): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const T = await import('@huggingface/transformers')
      T.env.localModelPath = MODEL_DIR
      T.env.allowRemoteModels = false
      const pipe = await T.pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8' })
      return async (texts: string[]) => {
        const out = await pipe(texts, { pooling: 'mean', normalize: true })
        const dims = 384
        const rows: Float32Array[] = []
        for (let i = 0; i < texts.length; i++) rows.push(out.data.slice(i * dims, (i + 1) * dims))
        return rows
      }
    })()
    embedderPromise.catch(() => { embedderPromise = null })
  }
  return embedderPromise
}

type VectorEntry = { line: number; text: string; vector: number[] }
let vectorCache: { mtimeMs: number; entries: VectorEntry[] } | null = null

async function recordVectors(records: ExperienceRecord[]): Promise<Float32Array[] | null> {
  const embed = await getEmbedder().catch(() => null)
  if (!embed) return null
  const mtimeMs = existsSync(EXPERIENCE_FILE) ? statSync(EXPERIENCE_FILE).mtimeMs : 0
  if (!vectorCache) {
    let entries: VectorEntry[] = []
    try {
      entries = JSON.parse(readFileSync(VECTOR_CACHE, 'utf8')).entries ?? []
    } catch { /* 缓存缺失或损坏：重建 */ }
    vectorCache = { mtimeMs: 0, entries }
  }
  if (vectorCache.mtimeMs === mtimeMs && vectorCache.entries.length === records.length) {
    return vectorCache.entries.map((e) => Float32Array.from(e.vector))
  }
  const stale = new Map(vectorCache.entries.map((e) => [e.line, e]))
  const needEmbedding: { line: number; text: string }[] = []
  const entries: VectorEntry[] = []
  records.forEach((r, line) => {
    const text = searchText(r)
    const hit = stale.get(line)
    if (hit && hit.text === text) entries.push(hit)
    else {
      const entry = { line, text, vector: [] as number[] }
      entries.push(entry)
      needEmbedding.push(entry)
    }
  })
  for (let i = 0; i < needEmbedding.length; i += 16) {
    const batch = needEmbedding.slice(i, i + 16)
    const vectors = await embed(batch.map((b) => 'passage: ' + b.text))
    batch.forEach((b, j) => { b.vector = Array.from(vectors[j]) })
  }
  vectorCache = { mtimeMs, entries }
  writeFileSync(VECTOR_CACHE, JSON.stringify({ model: MODEL_NAME, entries }))
  return entries.map((e) => Float32Array.from(e.vector))
}

// ---------- BM25 路 ----------
const STOP = new Set(['的', '了', '和', '与', '及', '或', '在', '是', '为', '对', '按', '后', '前', '时'])

function tokenize(text: string): string[] {
  const tokens: string[] = []
  const alnum = text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? []
  tokens.push(...alnum)
  const han = text.match(/[一-鿿]+/g) ?? []
  for (const seg of han) {
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
    if (seg.length === 1) tokens.push(seg)
  }
  return tokens.filter((t) => !STOP.has(t))
}

function bm25Scores(queryTokens: string[], docs: string[][]): number[] {
  const k1 = 1.5
  const b = 0.75
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const n = docs.length || 1
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / n || 1
  return docs.map((doc) => {
    const tf = new Map<string, number>()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const t of queryTokens) {
      const f = tf.get(t) ?? 0
      if (!f) continue
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLen)))
    }
    return score
  })
}

// ---------- 融合排序 ----------
function rrfFuse(rankings: number[][]): number[] {
  // rankings: 每路一个"按名次排列的文档下标"数组；返回融合得分
  const scores = new Array(rankings[0]?.length ?? 0).fill(0)
  for (const ranking of rankings) {
    ranking.forEach((docIdx, rank) => {
      scores[docIdx] += 1 / (RRF_K + rank + 1)
    })
  }
  return scores
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ---------- 推荐统计（沿用 fjsp-tools 原有口径：按模式平均加权拖期差值最优） ----------
// 任务 5.1：剔除负面 outcome（rejected/reworked/failed）的记录，避免仅凭历史平均 KPI 推荐被驳回/返工的模式
function recommendationFor(records: ExperienceRecord[], feedback: Map<string, FeedbackRecord>) {
  const stats: Record<string, { mode: string; count: number; tardinessSum: number; deltaPlanSum: number; deltaPlanCount: number }> = {}
  for (const r of records) {
    const oc = effectiveOutcome(r, feedback)
    if (oc && NEGATIVE_OUTCOMES.has(oc)) continue
    if (!r.mode || typeof r.kpiDiff?.weightedTardinessMinutes !== 'number') continue
    const s = (stats[r.mode] ??= { mode: r.mode, count: 0, tardinessSum: 0, deltaPlanSum: 0, deltaPlanCount: 0 })
    s.count += 1
    s.tardinessSum += r.kpiDiff.weightedTardinessMinutes
    if (typeof r.kpiDiff?.deltaPlan === 'number') {
      s.deltaPlanSum += r.kpiDiff.deltaPlan
      s.deltaPlanCount += 1
    }
  }
  const ranked = Object.values(stats)
    .map((s) => ({
      mode: s.mode,
      count: s.count,
      avgWeightedTardinessDiff: Math.round((s.tardinessSum / s.count) * 100) / 100,
      ...(s.deltaPlanCount ? { avgDeltaPlan: Math.round((s.deltaPlanSum / s.deltaPlanCount) * 1000) / 1000 } : {}),
    }))
    .sort((a, b) => a.avgWeightedTardinessDiff - b.avgWeightedTardinessDiff || (a.avgDeltaPlan ?? 0) - (b.avgDeltaPlan ?? 0))
  return ranked.length
    ? {
        mode: ranked[0].mode,
        reason: `历史 ${ranked[0].count} 次同类处置平均加权拖期差值 ${ranked[0].avgWeightedTardinessDiff}，为各模式最优`,
        byMode: ranked,
      }
    : null
}

// ---------- 查询入口 ----------
export async function experienceQuery(opts: { eventType?: string; query?: string; limit?: number; loadLevel?: string; dueUrgency?: string }) {
  const lines = readExperience()
  const feedback = latestFeedbackById(lines)
  const all = lines.filter((l) => l.kind !== 'feedback')
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
  const poolIdx = all.map((_, i) => i).filter((i) => !opts.eventType || all[i].eventType === opts.eventType)
  const pool = poolIdx.map((i) => all[i])
  const query = (opts.query ?? '').trim()
  const now = Date.now()
  const withQuality = (r: ExperienceRecord) => {
    const effectiveOutcome_ = effectiveOutcome(r, feedback)
    return { effectiveOutcome: effectiveOutcome_, quality: qualityOf(r, effectiveOutcome_, now) }
  }

  if (!query) {
    // 无语义条件：保持原有行为（时间倒序 + 模式统计推荐），仅附质量分/生效 outcome
    const matched = pool
      .slice(-limit)
      .reverse()
      .map((r) => {
        const q = withQuality(r)
        return { ...r, effectiveOutcome: q.effectiveOutcome, quality: Math.round(q.quality * 1000) / 1000 }
      })
    return {
      ok: true,
      retrieval: 'recency',
      total: all.length,
      matched: matched.length,
      records: matched,
      recommendation: recommendationFor(matched, feedback),
    }
  }

  const docs = pool.map(searchText)
  const docTokens = docs.map(tokenize)
  const queryTokens = tokenize(query)
  const bm25 = bm25Scores(queryTokens, docTokens)
  const bm25Ranking = bm25.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)

  let retrieval: 'hybrid' | 'bm25' = 'bm25'
  let fused: number[] = bm25
  const allVectors = await recordVectors(all).catch(() => null)
  if (allVectors) {
    const embed = await getEmbedder().catch(() => null)
    if (embed) {
      const [qv] = await embed(['query: ' + query])
      const sims = poolIdx.map((i) => cosine(qv, allVectors[i]))
      const vecRanking = sims.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)
      fused = rrfFuse([vecRanking, bm25Ranking])
      retrieval = 'hybrid'
    }
  }

  // 降权策略：默认 downweight（负面 outcome 以低质量分压底但保留兜底）；
  // filter 模式下剔除负面记录，若全部负面则回落 downweight（空结果回落语义不变）
  const policy = negativePolicy()
  let candidateIdx = pool.map((_, i) => i)
  if (policy === 'filter') {
    const kept = candidateIdx.filter((i) => {
      const oc = withQuality(pool[i]).effectiveOutcome
      return !oc || !NEGATIVE_OUTCOMES.has(oc)
    })
    if (kept.length > 0) candidateIdx = kept
  }

  const top = candidateIdx
    .map((i) => {
      const q = withQuality(pool[i])
      return { i, s: fused[i] * q.quality * contextBoost(pool[i], opts), ...q }
    })
    .sort((a, b) => b.s - a.s)
    .filter(({ s }) => s > 0)
    .slice(0, Math.min(TOP_K, limit))
  const matches: ScoredRecord[] = top.map(({ s, i, effectiveOutcome: oc, quality }) => ({
    ...pool[i],
    score: Math.round(s * 1000) / 1000,
    scoreText: `${retrieval === 'hybrid' ? 'RRF' : 'BM25'} ${fused[i].toFixed(4)} ×质量 ${quality.toFixed(3)}`,
    effectiveOutcome: oc,
    quality: Math.round(quality * 1000) / 1000,
  }))
  return {
    ok: true,
    retrieval,
    negativePolicy: policy,
    total: all.length,
    matched: matches.length,
    query,
    records: matches,
    recommendation: recommendationFor(matches.length ? matches : pool.slice(-limit), feedback),
  }
}

// 测试专用内部出口（agent-bff/test-rag.mts），不影响 server.mts 的消费方式
export const __ragInternals = { OUTCOME_WEIGHT, NEGATIVE_OUTCOMES, QUALITY_HALF_LIFE_DAYS, CONTEXT_MATCH_BOOST, latestFeedbackById, qualityOf, contextBoost, searchText }
