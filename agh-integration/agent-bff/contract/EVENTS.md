# BFF SSE 事件契约（版本语义）

本文件是 `agent-bff` 两条 SSE 流的事件契约说明；机器可读定义（事件名 → schema）在
同目录 `events.mts`（单一事实源），HTTP 端点契约在 `http.mts`。

## 流与事件全集

`/agent-api/stream`（会话事件流，stream = agent）：

| 事件 | v | 说明 |
| --- | --- | --- |
| `user_message` | 1 | 用户消息已受理（多标签页同步；发送方按内容去重） |
| `turn_start` | 1 | 回合开始 |
| `assistant_delta` | 1 | 助手回复流式增量（delta + offset） |
| `assistant_message` | 1 | 助手回复提交帧（整段替换增量，含 seq） |
| `tool_call` | 1 | 工具调用开始（name/args/toolUseId） |
| `tool_result` | 1 | 工具调用结果（code/isError/text，text 截断 4000 字符） |
| `permission_request` | 1 | 待人工审批（五要素审批卡片，见 approval 字段） |
| `permission_resolved` | 1 | 审批已裁决（撤销卡片） |
| `turn_end` | 1 | 回合结束（reason / stopReason） |
| `turn_error` | 1 | 回合异常中断（message / detail?） |
| `stream_closed` | 1 | BFF 与 daemon 的事件流关闭 |
| `resync_required` | 1 | 订阅的 sinceId 已出回放缓冲窗口（逐订阅者控制帧，不进回放缓冲、不占事件序号；客户端应重新 GET 会话快照后再订阅） |

`/agent-api/twin/stream`（设备快照流，stream = twin）：

| 事件 | v | 说明 |
| --- | --- | --- |
| `twin` | 1 | 设备快照 tick（1Hz，payload = 孪生快照；设备字段细节的事实源是 `mhs.mts` 的 AgnesHub） |

## 版本字段

每条事件的 payload 都带整数版本字段 `v`（当前全为 1），由 BFF 在广播时统一注入
（`events.mts` 的 `withVersion`），调用点只传业务字段。

## 版本演进规则

- **向后兼容变更不升版**：新增事件名、给既有事件新增可选字段。旧前端忽略未知事件/字段。
- **破坏性变更升版本号**：改字段含义/类型、删字段、改事件名语义。升级方式：事件名不变、
  `v` 递增，BFF 在过渡期可同时下发新旧两版（同名事件各发一条，按 `v` 区分）；前端按
  `v` 分流处理。任何 v ≥ 2 的事件必须先更新本文件与 `events.mts`，再改实现。
- 前端订阅的事件名集合必须是 `events.mts` 注册表的子集（契约测试
  `test-contract-api.mts` 脚本化强制，防止手写漂移复发）。

## 检查边界（types.ts ↔ events.mts 防漂移）

契约测试对 `types.ts`（静态类型）与 `events.mts`（运行时 schema）做**文本级字段一致性
断言**：每条事件的字段名集合、可选性（`?`）、可空性（`| null`）必须两侧一致。
**不覆盖**：TS 类型表达式与 schema 类型的等价性（如 `string` vs 枚举字面量、
`unknown[]` vs `array` 的元素结构），也不覆盖 `http.mts` 的 HTTP 请求/响应类型
（ChatRequest 等）——这些靠事件样本校验（合法样本须同时过运行时 schema）与
前后端事件名断言兜底。修改任一侧字段时须同步另一侧，契约测试会拦下遗漏。

## 校验行为

- BFF 在事件**发出前**用 `validateEvent` 校验：未知事件名、缺 `v`、payload 不符契约
  一律记日志并丢弃（不进回放缓冲、不推送给订阅者），绝不静默发畸形数据。
- 校验失败只影响该条事件，流本身不断开。
