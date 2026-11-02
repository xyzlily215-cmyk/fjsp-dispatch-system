#!/usr/bin/env node
// distill.mjs — 经验库蒸馏回路（任务 5.3，方案 2.4 语义记忆蒸馏）。
// 读取处置经验库（JSONL），按「扰动类型 × 处置模式」聚合高频成功模式
// （应用任务 5.1 的质量分 quality 与情景字段口径，与 agent-bff/rag.mts 保持一致），
// 产出提案文件 distill-proposal.md：建议固化进 SKILL.md 决策树的规则草稿 + 支撑证据计数。
// 人工闸门：本脚本只产出提案，绝不修改 SKILL.md；规则经人工 review 采纳后才并入 SKILL.md。
//
// 用法：
//   node distill.mjs [--experience-file <path>] [--out <path>] [--min-support <n>]
// 经验库路径默认取 FJSP_EXPERIENCE_FILE，缺省 ~/.agh/fjsp-experience.jsonl；
// 提案默认写到当前目录 ./distill-proposal.md。脚本对经验库只读。
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---- 与 agent-bff/rag.mts 任务 5.1 口径一致的常量（此处镜像，避免跨模块耦合） ----
const OUTCOME_WEIGHT = { success: 1.0, partial: 0.7, reworked: 0.4, failed: 0.3, rejected: 0.2 }
const NEGATIVE_OUTCOMES = new Set(['rejected', 'reworked', 'failed'])
const QUALITY_HALF_LIFE_DAYS = 60
const DEFAULT_MIN_SUPPORT = 3 // 单组样本数低于该值时提案明确写"证据不足"

const MODE_LABEL = { LOCAL_RESCHEDULE: '局部重排', FULL_RESCHEDULE: '完全重排' }
const EVENT_LABEL = { BREAKDOWN: '设备故障', NEW_ORDER: '紧急插单' }

function readExperience(file) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { records: [], badLines: 0, missing: true }
  }
  const records = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { records, badLines, missing: false }
}

// 反馈行（kind=feedback）按 experienceId 合并，同一经验取 feedbackAt 最新一条
function latestFeedbackById(lines) {
  const map = new Map()
  for (const l of lines) {
    if (l.kind !== 'feedback' || !l.experienceId) continue
    const prev = map.get(l.experienceId)
    if (!prev || String(l.feedbackAt ?? '') >= String(prev.feedbackAt ?? '')) map.set(l.experienceId, l)
  }
  return map
}

function effectiveOutcome(r, feedback) {
  return r.id ? (feedback.get(r.id)?.outcome ?? null) : null
}

// quality = outcome 权重 × 时间衰减；无反馈 outcome=null → 权重 1.0（旧记录不受罚）；ts 缺失/非法 → 不衰减
function qualityOf(r, outcome, now = Date.now()) {
  const w = outcome ? (OUTCOME_WEIGHT[outcome] ?? 1.0) : 1.0
  const t = r.ts ? Date.parse(r.ts) : NaN
  const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 0
  return w * Math.pow(0.5, ageDays / QUALITY_HALF_LIFE_DAYS)
}

// 计入成功模式的条件：生效 outcome 为 success，或无反馈（5.1 兼容口径，权重 1.0）；
// 负面 outcome（rejected/reworked/failed）与 partial 不进提案；求解不可行（resultStatus!=FEASIBLE）不计入。
function isSuccessEvidence(r, feedback) {
  if (r.kind === 'feedback') return false
  const oc = effectiveOutcome(r, feedback)
  if (oc && (NEGATIVE_OUTCOMES.has(oc) || oc === 'partial')) return false
  return r.resultStatus === 'FEASIBLE' && !!r.eventType && !!r.mode
}

function aggregate(lines, now = Date.now()) {
  const feedback = latestFeedbackById(lines)
  const groups = new Map()
  for (const r of lines) {
    if (!isSuccessEvidence(r, feedback)) continue
    const key = `${r.eventType} × ${r.mode}`
    const g =
      groups.get(key) ??
      (() => {
        const g0 = {
          key,
          eventType: r.eventType,
          mode: r.mode,
          count: 0,
          qualitySum: 0,
          published: 0,
          tardinessSum: 0,
          tardinessCount: 0,
          deltaPlanSum: 0,
          deltaPlanCount: 0,
          machines: new Map(),
          loadLevels: new Map(),
          dueUrgencies: new Map(),
        }
        groups.set(key, g0)
        return g0
      })()
    g.count += 1
    g.qualitySum += qualityOf(r, effectiveOutcome(r, feedback), now)
    if (r.published) g.published += 1
    if (typeof r.kpiDiff?.weightedTardinessMinutes === 'number') {
      g.tardinessSum += r.kpiDiff.weightedTardinessMinutes
      g.tardinessCount += 1
    }
    if (typeof r.kpiDiff?.deltaPlan === 'number') {
      g.deltaPlanSum += r.kpiDiff.deltaPlan
      g.deltaPlanCount += 1
    }
    if (r.machineId) g.machines.set(r.machineId, (g.machines.get(r.machineId) ?? 0) + 1)
    if (r.loadLevel) g.loadLevels.set(r.loadLevel, (g.loadLevels.get(r.loadLevel) ?? 0) + 1)
    if (r.dueUrgency) g.dueUrgencies.set(r.dueUrgency, (g.dueUrgencies.get(r.dueUrgency) ?? 0) + 1)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function topEntry(map) {
  let best = null
  for (const [k, v] of map) if (!best || v > best[1]) best = [k, v]
  return best
}

function ruleDraft(g) {
  const event = EVENT_LABEL[g.eventType] ?? g.eventType
  const mode = MODE_LABEL[g.mode] ?? g.mode
  const avgT = g.tardinessCount ? Math.round((g.tardinessSum / g.tardinessCount) * 100) / 100 : null
  const avgD = g.deltaPlanCount ? Math.round((g.deltaPlanSum / g.deltaPlanCount) * 1000) / 1000 : null
  const topMachine = topEntry(g.machines)
  const cond = [
    topMachine && g.eventType === 'BREAKDOWN' ? `故障设备为 ${topMachine[0]}（${topMachine[1]}/${g.count} 次）` : null,
    topEntry(g.loadLevels) ? `负荷 ${topEntry(g.loadLevels)[0]}` : null,
    topEntry(g.dueUrgencies) ? `交期紧迫度 ${topEntry(g.dueUrgencies)[0]}` : null,
  ]
    .filter(Boolean)
    .join('、')
  const lines = [
    `> 当${event}事件发生时${cond ? `（${cond}）` : ''}，优先采用 ${g.mode}（${mode}）。`,
    `> 历史依据：${g.count} 次同类成功处置（其中 ${g.published} 次已发布），` +
      `平均加权拖期差值 ${avgT ?? 'N/A'} 分钟、平均扰动率 Δ_plan ${avgD ?? 'N/A'}。`,
  ]
  return lines.join('\n')
}

function buildProposal({ groups, minSupport, file, total, badLines, missing, now = new Date() }) {
  const head = [
    '# 蒸馏提案（distill-proposal）',
    '',
    `> 由 \`agh-integration/skills/fjsp-dispatch/distill.mjs\` 于 ${now.toISOString()} 自动生成。`,
    `> 经验库：\`${file}\`（${missing ? '文件不存在' : `共 ${total} 行${badLines ? `，${badLines} 行无法解析已跳过` : ''}`}）。`,
    '> 本文件只是提案：脚本不修改 SKILL.md。采纳规则需人工 review 后手工并入',
    '> `agh-integration/skills/fjsp-dispatch/SKILL.md` 第二节决策树，并保留证据计数。',
    '',
    `聚合口径：扰动类型 × 处置模式；计入条件 = 生效 outcome 为 success 或无反馈记录`,
    `（负面 outcome rejected/reworked/failed 与 partial 不进提案）、resultStatus=FEASIBLE；`,
    `质量分 quality = outcome 权重 × 时间衰减（半衰期 ${QUALITY_HALF_LIFE_DAYS} 天），与 rag.mts 任务 5.1 口径一致。`,
    `最小支撑样本数 minSupport=${minSupport}。`,
    '',
  ].join('\n')

  if (missing || groups.length === 0) {
    return head + `## 结论\n\n经验库为空或没有可计入的成功模式，本轮无可蒸馏规则（空库不视为错误）。\n`
  }

  const supported = groups.filter((g) => g.count >= minSupport)
  const weak = groups.filter((g) => g.count < minSupport)
  const parts = [head, '## 建议固化的规则（达到最小支撑样本数）\n']
  if (supported.length === 0) {
    parts.push('（无：所有模式组样本不足，见下节。）\n')
  }
  supported.forEach((g, i) => {
    parts.push(
      `### 规则 ${i + 1}：${EVENT_LABEL[g.eventType] ?? g.eventType} → ${g.mode}\n`,
      ruleDraft(g),
      '',
      `支撑证据：n=${g.count}（quality 加权和 ${g.qualitySum.toFixed(3)}，已发布 ${g.published} 次）。`,
      '',
    )
  })
  parts.push('## 证据不足的模式组（不计入提案，仅列示）\n')
  if (weak.length === 0) {
    parts.push('（无）\n')
  }
  for (const g of weak) {
    parts.push(
      `- ${g.key}：n=${g.count} < minSupport=${minSupport}，**证据不足**，待积累更多同类处置记录后再评估。`,
    )
  }
  parts.push('')
  return parts.join('\n')
}

function parseArgs(argv) {
  const args = { minSupport: DEFAULT_MIN_SUPPORT }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--experience-file') args.file = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--min-support') args.minSupport = Number(argv[++i])
  }
  return args
}

export { readExperience, latestFeedbackById, effectiveOutcome, qualityOf, isSuccessEvidence, aggregate, buildProposal, DEFAULT_MIN_SUPPORT }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file || process.env.FJSP_EXPERIENCE_FILE || `${process.env.HOME}/.agh/fjsp-experience.jsonl`
  const out = args.out || './distill-proposal.md'
  const minSupport = Number.isFinite(args.minSupport) && args.minSupport > 0 ? args.minSupport : DEFAULT_MIN_SUPPORT
  const { records, badLines, missing } = readExperience(file)
  const groups = aggregate(records)
  const md = buildProposal({ groups, minSupport, file, total: records.length, badLines, missing })
  writeFileSync(out, md)
  console.log(`distill-proposal written: ${out}（模式组 ${groups.length}，达支撑 ${groups.filter((g) => g.count >= minSupport).length}）`)
}
