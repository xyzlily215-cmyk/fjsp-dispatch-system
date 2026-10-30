// rag: 扰动处置经验库的语义检索（RAG）。
// 双路召回：multilingual-e5-small 向量检索（本地 ONNX，离线可跑）+ BM25 关键词检索，
// RRF 融合排序；向量模型不可用时自动降级为纯 BM25，无 query 时保持原有的时间倒序行为。
// 嵌入缓存到 ~/.agh/fjsp-experience-vectors.json，按 JSONL 行号增量更新。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

const EXPERIENCE_FILE = `${process.env.HOME}/.agh/fjsp-experience.jsonl`
const VECTOR_CACHE = `${process.env.HOME}/.agh/fjsp-experience-vectors.json`
const MODEL_DIR = new URL('./models/', import.meta.url).pathname
const MODEL_NAME = 'multilingual-e5-small'
const TOP_K = 5
const RRF_K = 60

type ExperienceRecord = {
  ts?: string
  eventType?: string
  mode?: string
  machineId?: string
  resultStatus?: string
  kpiDiff?: { weightedTardinessMinutes?: number; deltaPlan?: number; cMaxMinutes?: number }
  published?: boolean
  note?: string
}

type ScoredRecord = ExperienceRecord & { score: number; scoreText: string }

// ---------- 记录加载与检索文本 ----------
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

function searchText(r: ExperienceRecord): string {
  const typeText = r.eventType === 'BREAKDOWN' ? '设备故障停机维修' : r.eventType === 'NEW_ORDER' ? '紧急插单新订单' : ''
  const modeText = r.mode === 'LOCAL_RESCHEDULE' ? '局部重排' : r.mode === 'FULL_RESCHEDULE' ? '完全重排' : ''
  const kpi = r.kpiDiff?.weightedTardinessMinutes != null ? `加权拖期差值 ${r.kpiDiff.weightedTardinessMinutes}` : ''
  return [typeText, r.machineId ? `机床 ${r.machineId}` : '', modeText, r.resultStatus, kpi, r.note ?? '']
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
function recommendationFor(records: ExperienceRecord[]) {
  const stats: Record<string, { mode: string; count: number; tardinessSum: number; deltaPlanSum: number; deltaPlanCount: number }> = {}
  for (const r of records) {
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
export async function experienceQuery(opts: { eventType?: string; query?: string; limit?: number }) {
  const all = readExperience()
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
  const poolIdx = all.map((_, i) => i).filter((i) => !opts.eventType || all[i].eventType === opts.eventType)
  const pool = poolIdx.map((i) => all[i])
  const query = (opts.query ?? '').trim()

  if (!query) {
    // 无语义条件：保持原有行为（时间倒序 + 模式统计推荐）
    const matched = pool.slice(-limit).reverse()
    return {
      ok: true,
      retrieval: 'recency',
      total: all.length,
      matched: matched.length,
      records: matched,
      recommendation: recommendationFor(matched),
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

  const top = fused
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .filter(({ s }) => s > 0)
    .slice(0, Math.min(TOP_K, limit))
  const matches: ScoredRecord[] = top.map(({ s, i }) => ({
    ...pool[i],
    score: Math.round(s * 1000) / 1000,
    scoreText: retrieval === 'hybrid' ? `RRF ${s.toFixed(4)}` : `BM25 ${s.toFixed(2)}`,
  }))
  return {
    ok: true,
    retrieval,
    total: all.length,
    matched: matches.length,
    query,
    records: matches,
    recommendation: recommendationFor(matches.length ? matches : pool.slice(-limit)),
  }
}
