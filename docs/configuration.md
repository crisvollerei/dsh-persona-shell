[首页](../README.md) / 配置参考

# 配置参考

日常操作优先使用设置页。这里集中列出插件行配置、默认值和部署相关选项。

[配置项](#配置项) · [路由认证](#路由认证) · [生效顺序](#生效顺序与参数约束)

---

日常使用优先在设置页调整。插件行定义位于 [`cordis.patch.yml`](../cordis.patch.yml)，完整默认值见 [`lib/config.js`](../lib/config.js)；已保存的页面设置会在加载后恢复。

## 配置项

| 配置项 | 默认值与用途 |
| :--- | :--- |
| `enabled` | `true` · 总开关。 |
| `trigger` | `step` · 每个汇报都改写；设为 `report` 则只改每轮最终汇报。 |
| `includeToolSteps` | `true` · 是否改写带工具调用的中间步骤。 |
| `processToolUsage` | `false` · 允许主会话过程转述查询阶段工具计数、可确认的工作性质与轻量会话节奏；需同时开启阶段性改写，仅适用于 `trigger: step`。 |
| `memory` | `true` · 是否启用跨会话风格记忆。 |
| `reviewHints` | `true` · 是否显示本地改写变化提示。 |
| `reviewThreshold` | `0.55` · 措辞变化提示阈值，范围 `0..1`；达到阈值才显示，关键表达变化只作解释。 |
| `progressNotices` | `false` · 是否在当前查看的主会话静默时，额外生成带 `◈` 前缀的状态播报。 |
| `progressMinutes` | `5` · 静默阈值，范围 `1..60` 的整数分钟；无新观测不重复调用。 |
| `subagentSteps` | `false` · 是否改写子代理的过程输出。 |
| `subagentReports` | `false` · 是否改写子代理的结论输出。 |
| `provider` / `model` | `''` · 改写所用模型；留空跟随当前会话。 |
| `reasoningEffort` | `''` · 改写调用的推理强度；留空不指定。 |
| `maxRewriteChars` | `6000` · 超过此长度的汇报直接跳过改写。 |
| `maxRatio` | `1.35` · 按打码文本校验长度；允许上限为原文的此倍数与原文加 200 字符中的较大值。 |
| `timeoutMs` | `45000` · 单次改写超时，单位毫秒；包含默认模型查询，超时回落原文。 |
| `keepSamples` | `2` · 随转述请求带入的历史语气样例数；样例保持打码，切换或编辑人格时清空。 |
| `maxRowsPerSession` | `240` · 每个会话保留的结果行上限。 |

## 路由认证

`allowUnauthenticatedRoutes` 默认为 `false`，没有 Connection 服务时拒绝开放 HTTP 路由。仅在明确接受未认证访问风险的特殊部署中考虑开启；它不绕过已存在的 Connection 拒绝，也不放宽 Remote 的 owner 检查。`/ping` 是不含敏感详情的公开例外。

## 生效顺序与参数约束

插件行配置先经过 `resolveConfig()` 补齐默认值；设置页可编辑的开关、阈值与模型路由，会在存储加载后恢复为已保存值。因此，修改行配置不一定覆盖设置页先前保存的选择。插件行总开关与当前会话开关仍然有效。

存储恢复期间在页面修改的开关和模型路由优先于旧存储值，未修改的字段照常恢复。人格卡编辑和预设变更需等待存储恢复完成，提前操作会明确返回失败，保留页面草稿供重试。

`includeToolSteps: false` 只排除带工具调用的步骤；不带工具调用的文本仍可能是中间汇报。严格只改每轮最终汇报时使用 `trigger: report`。

类型错误或超出范围的行配置回落默认值，不自动截到最近边界。完整约束以 [`lib/config.js`](../lib/config.js) 为准：

- `maxRewriteChars`：`200..60000`；`maxRatio`：`1..4`。
- `timeoutMs`：`1000..300000`；`keepSamples`：`0..8`；`maxRowsPerSession`：`20..5000`。
- `reviewThreshold`：`0..1`；`progressMinutes`：`1..60` 的整数。
- `provider`、`model` 与 `reasoningEffort` 接受字符串并去除首尾空白。

过程运行信息需要 `trigger: step`、阶段性输出改写与 `processToolUsage` 同时开启。静默播报独立控制，默认关闭；两者的作用范围见[使用指南](./guide.md)。

---

[使用指南](./guide.md) · [架构与边界](./architecture.md) · [返回首页](../README.md)
