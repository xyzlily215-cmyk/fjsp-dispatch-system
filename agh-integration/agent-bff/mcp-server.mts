// mcp-server: expose the 18 fjsp_* tools over the Model Context Protocol (stdio, NDJSON).
// Same implementations as the AGH plugin — this file imports the tools array from
// fjsp-tools/index.mjs, so AGH 插件与 MCP 是同一套代码的两种暴露形态。
//
// Approval semantics (P0 收紧，2026-10-30)：MCP 是无人值守直连通道，没有人工审批环节，
// 调用方自报的 "_confirm": true 不再作为人工批准证据。requiresApproval='always' 的工具
// （写/高风险/破坏性）在 MCP 入口一律拒绝（APPROVAL_CHANNEL_REQUIRED），须改走 Web 副驾
// （agent-bff，五要素审批 + 身份绑定）或 AGH 会话的原生人工审批；只读工具不受影响。
//
// Run:  ../agnes-harness/node_modules/.bin/tsx mcp-server.mts
// MCP client config example: { "command": "<abs path to tsx>", "args": ["<abs path>/mcp-server.mts"] }
import { createInterface } from 'node:readline'
import { tools, __contract } from '../fjsp-tools/index.mjs'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'fjsp-mcp', version: '1.0.0', title: 'FJSP 调度系统 MCP Server' }

type Json = Record<string, unknown>
type Tool = {
  name: string
  description: string
  parameters: Json
  meta?: { requiresApproval?: string; isDestructive?: boolean }
  execute: (args: Json) => Promise<{ content: { type: string; text: string }[]; isError?: boolean; structured?: unknown }>
}

const toolMap = new Map((tools as Tool[]).map((t) => [t.name, t]))

function send(msg: Json) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function resultFor(id: unknown, result: unknown) {
  send({ jsonrpc: '2.0', id, result })
}

function errorFor(id: unknown, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg: Json) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return resultFor(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'FJSP 动态柔性车间调度系统的 18 个工具。只读工具直接调用；写/高风险/破坏性工具（fjsp_create_baseline、fjsp_report_breakdown、fjsp_insert_order、fjsp_reschedule、fjsp_submit_review、fjsp_revise_plan、fjsp_experience_record、fjsp_approve_review、fjsp_publish、fjsp_reset_demo）在 MCP 直连通道一律拒绝执行（APPROVAL_CHANNEL_REQUIRED）——"_confirm" 参数不再作为人工批准证据；请通过 Web 副驾（agent-bff）或 AGH 会话的人工审批执行这些操作。',
    })
  }
  if (method === 'ping') return resultFor(id, {})
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'tools/list') {
    return resultFor(id, {
      tools: (tools as Tool[]).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
        annotations: {
          readOnlyHint: t.meta?.requiresApproval === 'never',
          destructiveHint: !!t.meta?.isDestructive,
        },
      })),
    })
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: Json }
    const tool = name ? toolMap.get(name) : undefined
    if (!tool) return errorFor(id, -32602, `unknown tool: ${name}`)
    // _confirm 不再放行：MCP 直连无人工审批环节，写/高风险/破坏性工具一律拒绝
    const { _confirm, ...toolArgs } = args ?? {}
    void _confirm
    if (tool.meta?.requiresApproval === 'always') {
      // 与工具核心同一套错误分类（任务 2.3）：入口层构造的错误也补齐 envelope 字段
      const cls = __contract.classifyError('APPROVAL_CHANNEL_REQUIRED')
      return resultFor(id, {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: {
              code: 'APPROVAL_CHANNEL_REQUIRED',
              message: `${tool.name} 是${tool.meta.isDestructive ? '破坏性' : '写/高风险'}操作：MCP 直连通道不支持人工审批，"_confirm" 不再作为批准证据。请通过 Web 副驾（agent-bff，身份绑定 + 五要素审批）或 AGH 会话的人工审批执行。`,
              category: cls.category,
              retryable: cls.retryable,
              recovery: cls.recovery,
            },
          }),
        }],
      })
    }
    try {
      const out = await tool.execute(toolArgs)
      return resultFor(id, {
        content: out.content,
        ...(out.structured !== undefined ? { structuredContent: out.structured } : {}),
        ...(out.isError ? { isError: true } : {}),
      })
    } catch (err) {
      return resultFor(id, {
        isError: true,
        content: [{ type: 'text', text: String(err instanceof Error ? err.message : err) }],
      })
    }
  }
  if (id !== undefined) return errorFor(id, -32601, `method not found: ${method}`)
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg: Json
  try {
    msg = JSON.parse(line)
  } catch {
    return errorFor(null, -32700, 'parse error')
  }
  void handle(msg).catch((err) => errorFor(msg.id ?? null, -32603, String(err)))
})
process.stderr.write('[fjsp-mcp] ready on stdio\n')
