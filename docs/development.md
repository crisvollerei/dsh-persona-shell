[首页](../README.md) / 开发指南

# 开发指南

本地检查、可选集成环境、源码分工与发布约定。测试范围与真实运行环境的验证范围需要分别理解。

[测试结构](#测试结构) · [状态同步与联调](#状态同步开发与联调) · [源码导览](#源码导览) · [文档与分发](#文档与分发)

---

使用支持 ES Modules 和内置测试运行器的 Node.js，在仓库根目录运行：

```bash
node --test 'test/*.test.mjs'
```

## 测试结构

默认测试完全离线，不需要安装外部依赖，也不会调用真实模型。可选集成测试与默认测试分开运行。

| 范围 | 内容 |
| :--- | :--- |
| **正文与存储** | 打码回填、改写校验、预设、风格记忆、持久化与卸载排空。 |
| **渲染与交互** | 官方渲染委托、会话开关、冲突退出与恢复、对照快照、响应式标签、阅读位置与原文浮层。 |
| **静默播报** | 可控时钟下的静默阈值、事实去重、调用上限、超时、视图租约、取消与等待用户。 |
| **过程运行信息** | 阶段分界与去重、跨区间返回、文件元数据去重和未知状态、轮间间隔与时钟变化、固定快照、函数续接、补充限长及正文/最终汇报隔离。 |
| **状态同步** | 快照与增量、慢消费者合并、跨实例版本、启动恢复、订阅重试、取消与卸载。 |
| **角色消息区** | 无主动调用、独立房间与共享时间线、接收人与私有记忆隔离、保存后生成、请求去重、重试/取消、成员变更、临时快捷回复与组合头像。 |
| **参考来源与焦点** | 点击前零额外读取、全局初始化、固定来源、被动读取与取消、项目名称投影、焦点频率、关联提醒去重、参考范围隔离与快捷回复过滤。 |

## 状态同步开发与联调

`lib/remote-contract.js` 是 Host/Client 共用的严格 Remote 描述符与边界校验；`lib/client-transport.js` 管理订阅生命周期。`lib/floating-layout.js` 提供独立于聊天与报告的本地窗口几何约束。为保持零运行时依赖，当前采用公共描述符/codec 接口，不引入 Typert TypeScript 生成工具链。浏览器副本由以下脚本嵌入现有 `client.js`，测试会检查副本与源实现逐字一致：

```bash
node scripts/build-client-sync.mjs
node scripts/build-client-sync.mjs --check
```

可选集成脚本位于 `test/integration/`，不属于默认离线测试，也不安装项目运行时依赖：

- `remote-runtime.mjs --deps <测试依赖目录/package.json>`：使用脚本锁定的 `0.2.1-rc.3` Cordis、Typert Registry、Gateway、Connection 和流监督器，验证开关推送、重连、Host 独立重载、注入作用域、卸载及 owner-only 边界；模型为禁止调用的替身。
- `desktop-runtime.mjs --executable <已安装客户端.exe> --browser-deps <playwright/package.json>`：使用临时 `DSH_HOME` 和临时 Electron 用户目录运行官方 Desktop，检查推送、开关、空闲请求、页面重载和连接恢复；不读取现有密钥或会话，不调用真实模型。
- `process-runtime.mjs --deps <SDK 测试依赖目录/package.json>`：用已发布的 `0.2.1-rc.3` 和 `0.2.2-rc.1` LLM SDK 分别核对增量/完整工具块、原生 assistant/tool 消息和提供方重放信息；不调用真实模型。
- `official-renderer.mjs`、`review-browser.mjs`、`comparison-browser.mjs`、`progress-runtime.mjs`：官方渲染、布局和播报生命周期的独立回归；具体依赖参数见各脚本开头。
- `memory-browser.mjs --deps <React/esbuild 依赖目录/package.json> --browser-deps <Playwright 依赖目录/package.json>`：运行真实 React 和实际记忆状态模块，检查原话核对、更正、撤销、采用、失败重试、角色隔离与键盘、深浅色及手机布局；不调用外部模型，可通过 `--executable` 指定浏览器。
- `settings-browser.mjs`：沿用上述依赖参数检查完整设置页的默认折叠、草稿保留、生成预设重试、键盘展开、模型选择及深浅色/窄屏布局；使用本地模拟 Host，不调用模型。
- `expression-runtime.mjs --deps <SDK 依赖目录/package.json>`：使用正式发布的 LLM SDK 与本地适配器，检查汇报默认关闭、聊天室的模型默认与自定义思考档、未知能力、准备后配置一致性和单次参数降级；不请求真实模型。
- `conversations-browser.mjs`：同样使用本地模拟 Host 和真实 React，检查会话选择冲突、接力取消、逐条反馈、关闭保留草稿、迟到响应、键盘焦点及深浅色/窄屏布局。
- `report-visualization-browser.mjs`：沿用 React/esbuild 与 Playwright 参数，检查完整原文、导览定位与临时侧标清理、重点阅读的展开与还原、顺畅阅读的主动生成与逐段原文核对、风险和相关上下文保留、原有代码样式、取消、独立缓存、双入口排列与深浅色/窄屏布局；模型使用受控替身。
- `report-theme-browser.mjs`：沿用相同参数，检查阅读主题、原生明暗标记、本机偏好恢复、混合外观下的文字和代码可读性，以及切换时的阅读状态保留；不调用模型。
- `chat-rooms-browser.mjs`（`persona-chat-browser.mjs` 保留为同一套检查的入口）：沿用 React/esbuild 与 Playwright 参数，连接实际插件 Host、本地存储和确定性模型替身，检查房间与发言目标、历史署名、缩略图与组合头像、房间草稿和来源隔离、生成中换人与移除、失败保存重试、候选只填入不发送及深浅色/窄屏布局；不请求外部模型。
- `chat-opening-browser.mjs`：沿用相同依赖参数，逐帧检查聊天室载入、重开、最小化还原与阅读页切换的显示连续性，以及草稿、选区和放大尺寸保留；不请求外部模型。
- `chat-images-browser.mjs`：沿用相同依赖参数，连接实际插件 Host 和受控附件、模型服务，检查选图、浏览器原生剪贴板 Ctrl+V、图片条目兼容、整窗拖入与反馈、缩略图、移除、仅文字兜底、房间隔离与窄屏布局；不请求外部模型。
- `chat-input-browser.mjs`：检查输入排队、引用、重试、流式顺序与合法沉默，另核对头像活动状态、点名顺序、减少动态效果，以及多人窄屏中「回到最新消息」的悬浮位置和点击回到底部；使用受控传输，不请求外部模型。
- `chat-suggestions-browser.mjs`：连接实际插件 Host 与受控模型，检查广播、单人和有序多人候选、默认人格不在房间时的生成、仅填入草稿、真实上下文变化拒绝与窄屏布局；不请求外部模型。
- `floating-windows-browser.mjs`：检查聊天室、阅读页与操作弹窗的标题拖动、边缘缩放、键盘调整、最小化及重开恢复、独立布局、阅读位置、视口变化、主题切换、窄窗口控制可达性和拖动取消；不请求外部模型。`comparison-browser.mjs` 另使用已发布的官方 Modal 与原生回退分别核对对照弹窗拖动、缩放和快照保留。
- `report-images-browser.mjs`：在真实浏览器加载已发布的官方 Markdown 和 AssistantMarkdown，对照原报告与阅读页的图片地址、顺序、替代文字、文件路径、引用式图片、加载失败、点击放大及窄窗口适配；核对顺畅稿与原文对照的资源作用域。额外传入 `--native-deps <官方 primitives 及其依赖的 package.json>`、`--fixtures <官方 ui-chat 包目录>` 和 `--output <输出目录>`；文件接口使用受控图片，不读取用户文件或调用模型。
- `chat-images-sdk.mjs --deps <SDK 依赖目录/package.json>`：使用已发布的 LLM SDK 和本地适配器核对原生图片块、准备后的视觉能力、未知能力与历史图片的文字降级；不请求外部模型。
- `report-thinking-sdk.mjs --deps <SDK 依赖目录/package.json>`：使用已发布的 LLM SDK 核对顺畅阅读强制思考的档位选择、能力未知与提供方拒绝时的明确提示，以及不静默退回关闭思考的重试边界；不请求外部模型。

`/persona-shell/ping` 的 `stateSync` 只公开流的数量统计与客户端状态枚举，供存活与连接排查。官方参考：[API Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.zh.md) · [添加 Remote API](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-remote-api.zh.md)。

## 版本约定

日常开发不提升包版本号；修复版本递增补丁号，新增一组面向用户的功能时可按发布计划递增次版本号。Git 标签、GitHub Release 和 npm 使用同一版本号，Release 附件和 npm 使用同一个安装包。

## 源码导览

```text
index.js              Host：事件判定、改写调用、校验、路由与持久化
client.js             Client：官方助手渲染委托、原文与变化提示、设置页
lib/
  mask.js             字面量打码与回填
  prompt.js           提示词构造与改写校验
  review.js           本地措辞变化评估与版本化元数据
  progress.js         静默状态播报的调度、事实摘要与校验
  tool-usage.js       按阶段分界的只读统计快照、调用与返回去重
  work-nature.js      工作性质三态归类与本地文件元数据去重
  session-pacing.js   会话轮次、本地小时与轮间空闲间隔
  process-rewrite.js  过程转述的受限函数续接与独立短补充
  expression-llm.js   插件独立调用的思考策略、能力选择与单次兼容降级
  expression-memory.js 各发言渠道共享的表达偏好约束
  memory-usage.js     有界的请求使用记录，仅保留引用、排除原因与发送状态
  pack.js             人格卡归一化与默认人格
  persona-expression.js 可信内置人格的聊天/汇报运行时表达视图
  preset.js           从人设提示词提取人格卡
  memory.js           旧版统计与本地语气纠正识别
  structured-memory.js 记忆条目、来源、范围、版本、候选与接力记录
  memory-consolidation.js 后台整理调度、取消、批次提交与提炼提示
  conversations.js    会话选择、版本检查、接力消费与串行持久化
  persona-chat.js     独立角色聊天、去重、重试、取消与有界持久化
  chat-prompt.js      仅使用本窗上下文的角色聊天提示与短消息协议
  chat-messages.js    当前人格视角的实际消息历史、原话指针与独立控制资料
  chat-palette.js     本地头像取色、近似色区分与浅深主题共用的气泡色
  chat-turn-plan.js   旧版计划协议与历史兼容校验
  chat-director.js    公共时间线上的统一判断、单席回应与原话依据
  chat-director-wire.js 绑定快照的有限选项协议与来源、原话位置解析
  model-route.js      显式设置、会话元数据与宿主全局默认模型回退
  chat-scheduler.js   每人格独立冷却、在途令牌与公开消息收件游标
  chat-input-queue.js 原始分段输入的持久化运输、回执去重与显式恢复
  chat-time.js        当前聊天轮次的时区校验、时间换算与只读提示上下文
  reply-suggestions.js 用户快捷回复候选提示与严格解析，不写入聊天
  avatar.js           本地头像格式与版本地址，和模型语气卡分开
  chat-profile.js     用户头像与可选称呼的独立版本记录、并发校验与串行持久化
  config.js           默认配置与 Standard Schema
  store.js            结果、预设与风格记忆的存储
  remote-contract.js  Host/Client 共享的严格 Remote 边界
  state-stream.js     Host 快照、增量与合并通知
  client-transport.js 官方流监督、订阅引用计数、兼容回退与续租
  report-visualization.js 完整原文快照与独立阅读协议
  report-emphasis.js  原句标注、段落分类提示与原文核对
  report-reading.js   原文导览与保守折叠计划，Host/Client 共用
  report-theme.js     阅读页主题色与对比度适配，浏览器副本由脚本生成
  report-views.js     最终报告的独立快照与有界阅读缓存
  report-readable.js  按原段落润色的独立阅读稿与可疑段落原文保留
  report-fidelity.js  数值、显式工作者称呼与少量许可语气的本地守卫
scripts/              共享状态与阅读规则的浏览器嵌入和一致性检查
locale/               中文与英文插件文案
assets/avatars/       随插件提供的内置人格头像及来源说明
test/                 离线与可选集成测试
```

## 聊天室辅助能力验证

`chat-support`、`chat-support-wire`、`chat-support-web` 和 `chat-support-host` 离线测试分别覆盖收据、有限协议、公开网络边界及真实 Host 调度入口；`test/integration/chat-support-browser.mjs` 检查等待进度、窄窗口、停止、来源与迟到结果，`chat-support-sdk.mjs` 核对已发布 SDK 的实际分派路线和物理请求预算。浏览器与适配器使用受控模型响应，不能据此判断模型正文质量。真实模型样本需固定输入与预算、保留格式失败和推演错误，分别记录路线、思考、延迟和 token；不能把任务到达等同于履行正确。

## 文档与分发

`README.md` 负责项目介绍和快速上手；`docs/` 保存使用、配置、架构与开发说明，`CHANGELOG.md` 记录版本变化。未实现的方向单列在[后续计划](./roadmap.md)。

首页插图位于 `docs/assets/`，两层架构图位于 `docs/layers.svg`。它们是静态 SVG，使用本地字体回退，无远程字体或脚本依赖；调整插图时保留标题、描述和正文中的文字说明。

`package.json` 的 `files` 显式包含文档与插图。调整文档位置后检查相对链接，并通过 `npm pack --dry-run` 确认分发内容。

---

[架构与边界](./architecture.md) · [后续计划](./roadmap.md) · [返回首页](../README.md)
