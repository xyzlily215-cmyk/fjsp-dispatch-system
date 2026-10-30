// contract/events.mts：BFF SSE 事件契约的单一事实源。
// 每条事件：名称 → { v（协议版本）, stream（所属流）, summary, schema }。
// server.mts 在事件发出前用 validateEvent 校验（畸形事件记日志并丢弃，不发给前端）；
// web-vue 侧的事件名清单由 test-contract-api.mts 做子集一致性检查，防止手写漂移。
// 版本语义见同目录 EVENTS.md：新增事件/可选字段向后兼容不升版，破坏性变更升 v。
import { TWIN_SNAPSHOT } from './http.mts'
import { validateValue, type Issue, type Schema } from './validate.mts'

export type SseEventContract = {
  /** 协议版本号（随 payload 的 v 字段下发） */
  v: number
  /** 所属 SSE 流：/agent-api/stream（agent）或 /agent-api/twin/stream（twin） */
  stream: 'agent' | 'twin'
  summary: string
  schema: Schema
}

const VERSION = { v: { type: 'integer', minimum: 1 } } as const

/** 审批五要素（permission_request 事件的 approval 字段；与 1.2 审批记录同源） */
const APPROVAL_INFO: Schema = {
  type: 'object',
  required: ['tool', 'risk', 'summary', 'digest', 'bizObject', 'requiredRoles', 'expiresAt'],
  properties: {
    tool: { type: 'string' },
    risk: { type: 'string', enum: ['READ', 'WRITE', 'HIGH_RISK', 'DESTRUCTIVE', 'UNKNOWN'] },
    summary: { type: 'string' },
    digest: { type: 'string' },
    bizObject: { type: ['object', 'null'] },
    requiredRoles: { type: 'array', items: { type: 'string' } },
    expiresAt: { type: 'number' },
  },
}

export const SSE_EVENTS: Record<string, SseEventContract> = {
  user_message: {
    v: 1, stream: 'agent', summary: '用户消息已受理（多标签页同步用，发送方按内容去重）',
    schema: {
      type: 'object', required: ['v', 'text', 'context'],
      properties: { ...VERSION, text: { type: 'string' }, context: { type: ['object', 'null'] } },
    },
  },
  turn_start: {
    v: 1, stream: 'agent', summary: '回合开始',
    schema: { type: 'object', required: ['v'], properties: { ...VERSION } },
  },
  assistant_delta: {
    v: 1, stream: 'agent', summary: '助手回复流式增量',
    schema: {
      type: 'object', required: ['v', 'delta', 'offset'],
      properties: { ...VERSION, delta: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
    },
  },
  assistant_message: {
    v: 1, stream: 'agent', summary: '助手回复提交帧（整段替换流式增量）',
    schema: {
      type: 'object', required: ['v', 'seq', 'text'],
      properties: { ...VERSION, seq: { type: 'integer' }, text: { type: 'string' } },
    },
  },
  tool_call: {
    v: 1, stream: 'agent', summary: '工具调用开始',
    schema: {
      type: 'object', required: ['v', 'seq', 'name', 'args', 'toolUseId'],
      properties: {
        ...VERSION, seq: { type: 'integer' }, name: { type: 'string' },
        args: {}, toolUseId: { type: ['string', 'null'] },
      },
    },
  },
  tool_result: {
    v: 1, stream: 'agent', summary: '工具调用结果（text 截断至 4000 字符）',
    schema: {
      type: 'object', required: ['v', 'seq', 'toolUseId', 'code', 'isError', 'text'],
      properties: {
        ...VERSION, seq: { type: 'integer' }, toolUseId: { type: ['string', 'null'] },
        code: { type: 'string' }, isError: { type: 'boolean' }, text: { type: 'string' },
      },
    },
  },
  permission_request: {
    v: 1, stream: 'agent', summary: '工具调用待人工审批（含五要素审批卡片）',
    schema: {
      type: 'object', required: ['v', 'requestId', 'toolCall', 'options', 'deadlineMs', 'approval'],
      properties: {
        ...VERSION,
        requestId: { type: 'string' },
        toolCall: { type: 'object' },
        options: { type: 'array' },
        deadlineMs: { type: 'number' },
        approval: APPROVAL_INFO,
      },
    },
  },
  permission_resolved: {
    v: 1, stream: 'agent', summary: '审批已裁决（撤销审批卡片）',
    schema: {
      type: 'object', required: ['v', 'requestId', 'verdict'],
      properties: { ...VERSION, requestId: { type: 'string' }, verdict: { type: 'object' } },
    },
  },
  turn_end: {
    v: 1, stream: 'agent', summary: '回合结束（reason=BFF 侧回合终因，stopReason=ACP 停因）',
    schema: {
      type: 'object', required: ['v', 'reason', 'stopReason'],
      properties: { ...VERSION, reason: { type: 'string' }, stopReason: { type: 'string' } },
    },
  },
  turn_error: {
    v: 1, stream: 'agent', summary: '回合异常中断',
    schema: {
      type: 'object', required: ['v', 'message'],
      properties: { ...VERSION, message: { type: 'string' }, detail: {} },
    },
  },
  stream_closed: {
    v: 1, stream: 'agent', summary: 'daemon 事件流关闭（BFF 与 daemon 断连）',
    schema: { type: 'object', required: ['v'], properties: { ...VERSION } },
  },
  twin: {
    v: 1, stream: 'twin', summary: '设备快照 tick（1Hz，payload = 孪生快照 + 版本字段）',
    schema: {
      ...TWIN_SNAPSHOT,
      required: ['v', ...(TWIN_SNAPSHOT.required ?? [])],
      properties: { ...VERSION, ...(TWIN_SNAPSHOT.properties ?? {}) },
    },
  },
}

/** 校验待发出的 SSE 事件：未知事件名 / 缺版本字段 / payload 不符均返回非空问题列表。 */
export function validateEvent(name: string, payload: unknown): Issue[] {
  const def = SSE_EVENTS[name]
  if (!def) return [{ path: '(event)', message: `未知 SSE 事件名：${name}` }]
  return validateValue(def.schema, payload)
}

/** 注入版本字段：所有事件统一带 v，调用点只传业务字段。 */
export function withVersion(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  const def = SSE_EVENTS[name]
  return { v: def?.v ?? 1, ...payload }
}
