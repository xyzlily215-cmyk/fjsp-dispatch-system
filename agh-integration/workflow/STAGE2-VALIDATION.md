# 第二阶段在线验收记录（2026-11-11）

## 授权与范围

用户明确批准：安装/信任/启用 @fjsp/analysis-guard；先最多3次模型调用，再追加最多2次；发现共享上下文污染后批准建立独立分析home/daemon并本地复用既有模型凭据。只使用合成车间数据，不调用真实业务写接口、不重置演示库，不修改原模型账号。

第一阶段提交：e8bbf40。第二阶段尚未提交。

## 环境

- AGH Node v24.21.0；模型 DeepSeek deepseek-flash（由AGH配置服务核实，不根据README推断）。
- 原运行home ~/.agh；独立分析home ~/.agh-fjsp-analysis，profile local-dev，单独数据/Socket，computerUse关闭。
- 分析环境只安装AGH内置辅助插件与分析guard，无MHS、fjsp-tools。
- guard包版本1.0.0；安装完整性 sha256-f3ca76c8bd1bbdd93493922afaa564da84a86e06fdd826c1beacd1b4b7c1e941；actual=running/trusted=true。
- 使用AGH credential-store读取原账号，并通过独立环境的config.save写入；未打印、记录或提交API key。
- 当前网关单价未知，不报告猜测金额；调用预算按次数控制。每次分析后端限制单步骤/2048输出token，应用层无自动重试，底层供应商瞬时重试不是应用层调用次数。

## 在线发现与修正

1. 初始握手未通过，模型未调用：真实扩展账本字段为 origin，而非模拟测试使用的 source。修正为匹配 x/plugin/<row哈希>/ready 与 origin=ext:plugin/<row哈希>，新增wrong-origin拒绝回归。
2. 原共享profile MHS context hook向分析请求自动注入设备读数：第二次模型调用引用了输入外设备状态，判不合格；未误报通过。
3. 修复：建立独立分析home；适配器默认只连独立owner，调用前包名白名单检查；MHS、fjsp-tools或未知包均fail-closed。
4. 原程序冲突证据模板只识别type/message，实际算法字段是rule/objects/suggestion，导致原始证据段为空。补齐兼容并回归。
5. 隔离后模型仍可能把“求解未找到合格方案”说成数学无解，或提出维修窗口尾段复用等不当建议。提示词补强，冲突说明后程序固定声明硬约束不可放宽；最终提示词修改后只做离线验证，未追加第6次模型调用。自由文本质量不宣称彻底解决。

## 模型调用结果（累计5次）

| 次数 | 节点 | 环境 | 来源/结果 | 耗时 |
|---|---|---|---|---|
| 1 | strategy | 共享profile，工具guard生效 | model，结构合法；随后发现该环境存在上下文污染风险，不作为最终隔离验收 | 2986ms |
| 2 | conflicts | 共享profile | model，但引用外部实时设备状态，不合格 | 4980ms |
| 3 | review | 独立分析daemon | model；无外部设备读数；程序KPI证据完整 | 4614ms |
| 4 | strategy | 独立分析daemon | model；LOCAL与四有效目标权重合法，数据均来自合成输入 | 4087ms |
| 5 | conflicts | 独立分析daemon | model；rule/objects/suggestion证据完整，无外部设备读数；解释质量有上述限制 | 4089ms |

各会话均为独立fjsp-analysis随机key；合成输出与完整会话留在本机AGH账本及/tmp日志，不提交包含实时设备读数的原始记录。没有任何业务写工具执行。

## 离线回归

- 全部10个workflow/test-*.mts脚本通过，扰动流程15组。
- 新模型适配、guard、AGH传输测试通过，覆盖wrong-origin、缺guard、MHS/业务包拒绝、非法输出、超时取消、工具尝试、连接关闭、来源记录、算法冲突证据。
- 工具主契约与阶段1上下文测试通过。
- model-agent、agh-analysis、model-smoke及新测试独立tsc --noEmit通过。
- git diff --check通过。

## 运行与停止

独立daemon本次已启动，供后续使用；无需重新配置模型。重启命令（Node需>=24.10）：

```sh
node agh-integration/agnes-harness/packages/cli/dist/local/daemon.mjs \
  --home "$HOME/.agh-fjsp-analysis" --profile local-dev \
  --workspace "$PWD/agh-integration" --data-dir "$HOME/.agh-fjsp-analysis/data"
```

停止仅针对独立实例：使用AGH支持的daemon stop与该home/data-dir，确认进程身份后执行；不要停止原车间daemon，不删运行时快照。该命令需在项目根运行。

## 验收结论

模型节点真实接线、后端工具限制、独立上下文和降级机制已做在线/离线验证。不是模型决策质量全面评估，不是Web Workflow入口验收，不是评审发布业务闭环验收；后两项仍属阶段3/4。
