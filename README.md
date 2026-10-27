# dsh-persona-shell

为 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的助手汇报套一层人格化转述的插件：**人格只活在呈现层，不进入工作层**。

> A DSH plugin that re-speaks every assistant report in a persona while leaving the working prompt untouched. The original report is always one click away.

## 为什么不是「人格提示词全局注入」

把人设写进 system prompt 也能让角色立住，但每个 step 都要为它付一次上下文和注意力，长任务里尤其明显。这个插件的取舍相反：

| 约束 | 做法 |
| --- | --- |
| 工作面零污染 | 不碰 system prompt、工具集、agent 循环、会话日志 |
| 人格面单向 | 套壳层只读已提交的 assistant 消息，工作面读不到人格文本 |
| 改写不回灌 | 结果只存在插件自己的存储与页面状态里，绝不写回会话记录 |
| 原文是真相 | 每轮最后一条汇报可切「原文」；改写失败一律回落原文 |
| 技术内容不被改写 | 代码、路径、命令、URL、版本号先在本地打码，模型拿不到真实字节 |

最后一条和第三条是整套设计成立的前提：一旦改写文本进入会话，模型下一轮就会模仿这个腔调，工作层与人格层的解耦立刻失效。

## 特性

- **每个 step 都能套壳**：不只最终汇报，带工具调用的中间叙述（「现在改常量…」这类）默认也改写，可关。
- **字面量保护**：围栏代码、行内码、URL、绝对路径、命令、版本号在本地替换为 `[[n]]` 标记后只送叙述给模型；标记缺失、多余、重复或被改写，整条丢弃、回落原文。
- **流式显示**：改写逐段落地，不是全部完成才一次性出现。
- **原文对照**：每轮最后一条汇报带「原文」按钮。
- **多个人设预设**：可粘贴一整段现成人设提示词，自动提取「怎么说话」生成人格卡（外貌、背景故事会被丢弃）。
- **风格记忆**：跨会话统计提问语言、称呼方式与句长，用来微调语气；只保存计数，不保存原文，可随时清空。
- **子代理独立开关**：过程输出与结论输出分开控制。
- **可回退**：关闭插件开关即释放渲染槽位，官方渲染器完整恢复。

## 安装

前置：已安装可管理插件的 DSH Desktop 或 Web 版本。开发与验证基于 `0.2.1-rc.3`。

**方式一：从 Git 仓库安装（推荐）**

1. 侧边栏打开 **Plugins** → **Add plugin**；
2. 选择 **Install a third-party plugin**，填入 Git 地址：

   ```
   https://github.com/crisvollerei/dsh-persona-shell
   ```

3. 安装完成后启用该 bundle；如果 DSH 提示需要重启，重启一次客户端。

**方式二：本地目录**

克隆仓库后，在 Add plugin 中选择本地目录，指向仓库根目录即可。

安装完成后进入 **设置 → 人格套壳** 配置。

## 使用

- 助手每完成一段汇报，聊天区显示人格版；每轮最后一条带「原文」对照。
- **设置 → 人格套壳** 里可以改：
  - 是否同时改写阶段性输出；
  - 子代理过程/结论两个独立开关；
  - 长期记忆开关、当前学到的内容与清空；
  - 人设预设的启用、改名、删除；
  - 人格卡编辑（身份、汇报说话规则、通用语感、语气示例、禁区、子代理称呼）；
  - 从一段人设提示词生成新预设；
  - 改写所用模型（默认跟随当前会话）。
- 内置预设「大肥鱼（默认）」不可删除；编辑内置预设时会自动另存为一个新预设，之后随时可以切回。

## 配置

插件行配置在 `cordis.patch.yml`（设置页可改的项会与这里的默认值合并）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `trigger` | `step` | `step`：每个汇报都套；`report`：只套每轮最终汇报 |
| `includeToolSteps` | `true` | 是否改写带工具调用的中间步骤 |
| `memory` | `true` | 是否启用跨会话风格记忆 |
| `subagentSteps` | `false` | 是否改写子代理的过程输出 |
| `subagentReports` | `false` | 是否改写子代理的结论输出 |
| `provider` / `model` | `''` | 改写所用模型；空值表示跟随当前会话 |
| `reasoningEffort` | `''` | 改写调用的推理强度；空值表示不指定 |
| `maxRewriteChars` | `6000` | 超过该长度的汇报不改写 |
| `maxRatio` | `1.35` | 改写结果相对原文的长度上限 |
| `timeoutMs` | `45000` | 单次改写超时，超时回落原文 |
| `keepSamples` | `2` | 作为语气参考带入的历史样例条数 |
| `maxRowsPerSession` | `240` | 每个会话保留的结果行上限 |
| `allowUnauthenticatedRoutes` | `false` | 无 Connection 服务时是否仍提供插件路由（默认拒绝） |

## 工作原理

1. Host 订阅会话提交事件，挑出有正文的 assistant 汇报（中断的、空正文的、纯工具调用的会跳过）。
2. 本地打码：把代码、路径、URL、命令、版本等替换为 `[[n]]` 标记，只把叙述段送模型。
3. 用会话当前模型（或配置指定的模型）改写；回填标记后校验标记集合、长度、不得引入代码围栏。
4. 结果写入插件自己的 `persona_shell` 存储域，**不写会话日志**。
5. Client 轮询状态，在聊天区的 `assistant-step` 位置渲染人格版；失败或超时显示原文。

## 已知限制

- **接管期间会隐藏部分官方内容**：`conversation.chat.node` 是 keyed 槽，接管后 reasoning 折叠面板、图片块、中断标记、运行中状态不显示；「原文」视图也只含文本块。关闭插件开关会释放槽位，官方渲染器完整恢复。
- **页级生效**：所有会话共用一个渲染器，没有会话级开关。
- **依赖官方 Markdown 渲染器**：若 `@deepseek-ai/dsh-client-ui-primitives` 不再提供 `MarkdownText`，会明显降级为纯文本，并在设置页提示。
- **轮询同步**：Client → Host 无推送，按固定节奏轮询。
- **需要 Connection 服务**：插件路由默认拒绝无认证请求；没有 Connection 的部署需显式设置 `allowUnauthenticatedRoutes: true`。
- **记忆采集等待存储确认**：存储里的开关恢复前不采集；存储不可用时保持关闭，避免用默认值覆盖用户已关掉的开关。
- **未系统验证**：长会话性能、多会话并发、真实 Desktop 下的极端时序。

## 目录

```
index.js          Host 半：事件判定、打码、改写调用、校验、路由、持久化
client.js         Client 半：聊天渲染覆盖 + 设置页
lib/mask.js       字面量打码与回填
lib/prompt.js     提示词构造与改写校验
lib/pack.js       人格卡归一化
lib/preset.js     从人设提示词提取人格卡
lib/config.js     插件配置（Standard Schema）
lib/store.js      结果与预设的持久化
locale/           插件显示名与文案（en / zh）
cordis.patch.yml  插件行定义
test/             离线测试
```

## 开发

```bash
node --test 'test/*.test.mjs'
```

94 项离线测试，无外部依赖。默认人格卡是 DeepSeek 社区同人设定的鲸鱼娘「大肥鱼」，第一人称「鲸鲸」；它只是默认值，可在设置页替换成任意人格。

## 许可证与素材

代码以 [MIT](LICENSE) 发布。

默认人格「大肥鱼」来自 DeepSeek 社区的同人鲸鱼娘设定；`icon.png` 是社区素材的裁剪版本，仅用于插件展示，版权归原作者。
