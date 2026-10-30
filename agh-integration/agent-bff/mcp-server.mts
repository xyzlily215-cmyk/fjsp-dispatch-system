// mcp-server: expose the 18 fjsp_* tools over the Model Context Protocol (stdio, NDJSON).
// Same implementations as the AGH plugin — this file imports the tools array from
// fjsp-tools/index.mjs, so AGH 插件与 MCP 是同一套代码的两种暴露形态。
//
// Approval semantics mirror the AGH side: tools with requiresApproval 'always'
// (writes / high-risk / destructive) need `"_confirm": true` in the call arguments,
// the MCP-side equivalent of the human approval card; read-only tools run directly.
//
// Run:  ../agnes-harness/node_modules/.bin/tsx mcp-server.mts
// MCP client config example: { "command": "<abs path to tsx>", "args": ["<abs path>/mcp-server.mts"] }
import { createInterface } from 'node:readline'
import { tools } from '../fjsp-tools/index.mjs'

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
        'FJSP 动态柔性车间调度系统的 18 个工具。只读工具直接调用；写/高风险/破坏性工具（fjsp_create_baseline、fjsp_report_breakdown、fjsp_insert_order、fjsp_reschedule、fjsp_submit_review、fjsp_revise_plan、fjsp_experience_record、fjsp_approve_review、fjsp_publish、fjsp_reset_demo）需要在 arguments 里带 "_confirm": true 才会执行——这是 MCP 侧与 AGH 人工审批等价的显式确认。',
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
    const { _confirm, ...toolArgs } = args ?? {}
    if (tool.meta?.requiresApproval === 'always' && _confirm !== true) {
      return resultFor(id, {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: {
              code: 'CONFIRM_REQUIRED',
              message: `${tool.name} 是${tool.meta.isDestructive ? '破坏性' : '写/高风险'}操作：请在 arguments 中显式带 "_confirm": true 再调用（等价于 AGH 侧的人工审批确认）。`,
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
