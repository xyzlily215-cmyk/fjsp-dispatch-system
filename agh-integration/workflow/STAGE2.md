# 阶段 2：AGH 模型决策节点

## 已实现与未验证的边界

- `model-agent.mts` 实现三个模型方法：策略建议、冲突解释、评审材料。
- `agh-analysis.mts` 使用现有 AGH Node SDK 与 daemon 通信，不新建供应商 HTTP 调用，不读取或复制模型密钥。
- 每次方法调用使用独立 sessionKey 和专用分析工作区，不加载聊天历史、不写共享 `.agh-session-id`。
- `analysis-guard/` 已安装并启用：对带专用 marker 的工作区拒绝所有工具（含只读、设备、shell），限定一个推理步骤和 2048 输出 token。普通会话不改变。
- 适配器必须在发 prompt 前读到指定插件的可信来源 ready 事件；缺少插件/策略不匹配则不调用模型，返回显式规则兜底。
- **经用户确认完成插件安装、独立分析 daemon 建设和5次合成数据模型调用。** 隔离后的三个模型节点均返回 model 来源；不代表完整业务闭环或模型质量全面达标。详见 `STAGE2-VALIDATION.md`。

## 调用方接线

```ts
import { createAghDisturbanceAgent } from './agh-analysis.mts'
const agent = createAghDisturbanceAgent({
  workspace: '/absolute/path/to/dedicated-analysis-workspace',
  timeoutMs: 60_000,
})
// 每个运行中的 workflow 使用自己的 agent 实例（lastInvocation 为实例内调用证据）。
await runWorkflow(workflowId, buildDisturbanceFlow(), { store, tools, agent })
```

上述分析目录必须专用、与业务代码工作区分离，并预置 `.fjsp-analysis-workspace.json`：

```json
{"version":1,"mode":"fjsp-workflow-analysis"}
```

marker 只是选择后端策略的标识，不是授权凭据。真正限制由已安装可信插件的 directive hook 执行；ready 事件的 `origin=ext:plugin/<row哈希>` 绑定该插件 row。普通用户文本不能伪造账本扩展事件来源。插件不是进程沙箱；不要在该目录安装其他不可信插件。

默认 owner 文件改为 `~/.agh-fjsp-analysis/data/daemon/owner.json`，不连接共享车间 `~/.agh`。连接后会检查安装包，仅允许分析保护与AGH内置辅助插件；发现MHS、fjsp业务工具或未知插件即报 CONTEXT_NOT_ISOLATED。隔离 home 由用户批准建立，原账号通过AGH配置服务在本地复用，密钥不进入仓库。

## 输出、安全与降级

- 输入按字节上限 96000 检查，超限失败，不静默截断业务事实。
- 输出按 16000 字节检查，只接受完整 `end_turn` JSON，不拼接 Markdown 围栏、不修补截断 JSON。
- 策略复用阶段1合法性校验，补全有效权重；未知字段/非法模式/非法权重回退默认策略。
- 备注和经验按不可信数据交给模型，不授予操作能力。后端工具拦截是安全边界，提示词只是辅助。
- 模型超时触发 AbortSignal 与 session.cancel，关闭专用客户端，清理事件订阅；应用层不自动重试模型请求。AGH/供应商自身的瞬时重试仍由当前 profile 控制，应在在线预算确认时一并检查。
- `lastInvocation()` 返回 model/rule-fallback、原因码、sessionId、耗时；异常明文不进记录，避免泄露 endpoint/key。
- disturbance-flow 的建议与材料节点将来源记录进检查点。原有自定义 agent 未提供来源接口时标为 injected-agent，不冒充真实模型。
- 评审材料追加程序生成的 KPI/差异证据段，模型说明明确标为待人工核实；不承诺能够完全检测自由文本中的错误解释或数字。
- 来源只是审计记录，不是批准；评审/发布仍沿用既有人工决策。阶段3/4的授权写入通道、Web入口和业务审批闭环不在本次范围。

## 安装准备（需另行确认后操作实际 daemon）

复用 AGH Web：Settings → Plugins → Install from source，源路径为 `file:./analysis-guard`（相对 daemon 启动 workspace），检查包名 `@fjsp/analysis-guard`、完整性、能力预览，确认后启用。注册 hook 失败或缺少权限会使安装不可用，适配器不会绕过。

安装源码不代表已激活；必须核查实际状态。不得为了测试禁用原业务审批，也不得复用自动批准 driver。

## 无付费回归

使用本地已安装 tsx：

```sh
tsx agh-integration/workflow/test-model-agent.mts
tsx agh-integration/workflow/test-analysis-guard.mts
tsx agh-integration/workflow/test-agh-analysis.mts
# 同时跑原有 workflow/test-*.mts 与 fjsp-tools/test-*.mjs
```

覆盖合法与非法结构、模式/权重、空/超长/截断/拒绝输出、超时、取消、guard缺失不发prompt、工具调用尝试、程序化数值证据、连接关闭及普通会话不受影响。

本次离线结果：全部10个 workflow/test-*.mts 脚本通过（扰动流程15组）；工具主契约及上下文契约通过；新 model-agent/agh-analysis、在线smoke及其测试对当前 AGH SDK 的独立 tsc --noEmit 检查通过；git diff --check 通过。真实模型、插件与隔离环境验证另见验收记录，业务数据未变更。

## 在线 smoke

用户已批准最多3次、随后追加最多2次调用，共5次，模型为现有 DeepSeek deepseek-flash。适配器使用独立分析home中的同模型配置，不修改原模型账号。每次命令只运行一个节点，需显式允许计费，并指定尚不存在的专用目录：

```sh
tsx agh-integration/workflow/model-smoke.mts --allow-billed --operation strategy --workspace /absolute/new-analysis-workspace
# --operation 可选 strategy / conflicts / review；不传默认为 strategy
```

脚本绝不读取真实订单；没有 model 来源时退出码为1，不能把 fallback 当模型验收成功。专用目录和 AGH 留痕保留供审计，不自动删会话。真实供应商单价与底层重试尚未核实，不能预先保证金额；在线执行前单独确认。

## 回滚

本阶段尚未提交：仅撤销第二阶段补丁/新增模块，第一阶段基线提交为 `e8bbf40`。如果之后安装了 guard，先确认没有分析任务运行，再通过 AGH 管理界面禁用/移除该插件；不手工删除运行时快照，不影响原 fjsp-tools 与业务状态。
