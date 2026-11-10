# 更新记录 / Changelog

## 0.5.1

### 汇报表达与阅读

- 默认转述改用更自然的段落节奏，更新五位内置人格的汇报专用示例；可在设置中关闭口语化。人格主要影响措辞，原报告的事实、条件、风险和工作归属仍须保留。
- 完善「调整表达」：支持短一点、先说结论等单次要求；重新转述始终读取同一原文，进一步补全能确定的主谓关系，给信息密集的报告留出解释空间。失败保留旧稿与输入，不将本次要求自动写入长期记忆。
- 新增独立报告阅读页，提供完整原文、原文导览和可展开的重点阅读。保留原顺序、代码样式、条件与风险，并支持阅读位置恢复、最小化和 Catppuccin、Nord、Rosé Pine 配色。
- 阅读页新增「顺畅阅读」，主动生成逐段润色稿，可就地核对原文。默认开启独立思考，按模型公开的默认强度处理；生成前提示准确性风险，支持「今日不再提醒」。可恢复的格式差异在本地整理，局部缺失保留原文，不自动追加修复调用。

### 聊天室讨论与交互

- 统一安排多人格发言，按最新公共聊天准备下一位的请求；支持向整个房间说话或有序选择多位对象。每位人格独立管理冷却与发言机会，可以自然接话、暂不发言或等待用户，不要求轮流表态或用满次数。
- 加入引用消息回复、连续气泡分组、自然时间显示和基础时间感知。气泡按人格配色；支持自定义对用户的称呼，聊天室设置与插件设置共用思考开关和强度选择。
- 工作参考按本轮需求筛选，闲聊不默认带入整份工作资料。保留来源所属轮次，长报告使用明确的片段预算，新一轮的阶段进度不会抹掉上一轮完整报告；只使用已接入来源的原始工作内容。
- 设置页新增房间讨论状态和参考使用核对，可依据原话整理、更正或撤销方案与决定。房间记录、参考范围和人格私有偏好保持隔离；角色自述和临时职责不代表用户已经确认。
- 讨论中的原话可以整理为可编辑工作指令。核对目标与依据后，可复制或填入工作输入框，由用户修改并发送；不自动提交任务或调用工作子代理。

### 稳定性与边界

- 修复本轮点名对象、主讲顺序、工作参考归属、跨房间误取消，以及流式气泡、重试与断线恢复的问题。房间搜索、草稿、输入选区和阅读位置可在本机恢复。
- 修复重启后的模型继承与模型目录查询边界，完善思考档位的能力校验和兼容回退；正式汇报、聊天室和阅读润色的设置分别生效。
- 改善代码字面保护、局部措辞变化提示和阅读折叠规则，减少普通散文与同义表达被误判；这些本地检查不保证语义完全一致，重要信息仍需对照原文。
- 记忆后台整理按人格与会话公平取批，避免较早的少量记录阻塞其他会话；原话依据、条目版本与私有范围继续校验。

## 0.5.0

### 工作汇报与独立聊天室

- 工作页新增「聊天室」。第一次点开时才载入；同一房间可以中途换人，也可以点选最多两位人格按顺序主讲。其余成员共用一次接话判断，不会人人轮流复述。支持流式分段气泡、失败重试和最小化后的回复提醒。
- 每个房间可以固定参考哪些工作会话。切换工作页不会更换来源；聊天使用原始工作目标和汇报，不把人格转述当作事实。只补发附件也会开始新的输入边界，不会把旧答案算到新问题上。
- 工作会话可单独选择汇报人格、安排下一份汇报接力，或只调整某一次的表达。原文和历史署名保留，截断或中断的输出不会被提升为最终汇报。

### 人格、记忆与用量

- 五位内置人格都配有头像，新增 Gemini「猫猫」，实验性预设更名为「小肥鱼」。群聊中保留姐妹、搭档等称呼与关系。自定义内置头像或人设时另存副本，用户头像也可单独设置或隐藏。
- 记忆的更正、撤销和确认集中在设置页，能看到原话依据和实际使用情况。「只限你」的偏好留给对应人格；明确要求所有人格共享的自动候选，也要在设置中采纳后才生效。
- 设置页可分别查看转述、聊天室等用途的调用次数、模型和 token 趋势。聊天室默认跟随转述模型，也可以另选模型并单独控制思考。统计不保存消息正文或提示词。

## 0.4.10

### 中文

#### 兼容性

- 适配 DSH `0.2.2-rc.1`：将 `engines.dsh` 从 `>=0.2.1-rc.3 <0.2.2-0` 放宽为 `>=0.2.1-rc.3 <0.3.0-0`，0.2.2 系列（含候选版与正式版）不再因版本上限被拒绝加载。
- 在 DSH `0.2.2-rc.1` 官方 Web 运行时中实际加载验证：Host 事件（`session/event`、`agent/assistant-stream`、`agent/status`）、`llm` / `agents` / `webServer` / `storageDomain` / `typert` 服务与官方客户端注入均正常，设置页与诊断接口可用；本次为纯兼容更新，不改变现有功能与存储格式。

### English

#### Compatibility

- Support DSH `0.2.2-rc.1` by widening `engines.dsh` from `>=0.2.1-rc.3 <0.2.2-0` to `>=0.2.1-rc.3 <0.3.0-0`, so the 0.2.2 series (prereleases and stable) is no longer rejected by the upper bound.
- Verified by loading the plugin into the official DSH `0.2.2-rc.1` Web runtime: the Host events (`session/event`, `agent/assistant-stream`, `agent/status`), the `llm` / `agents` / `webServer` / `storageDomain` / `typert` services, and official client injection all work, with the settings page and diagnostic routes responding. Compatibility-only update with no behavior or storage-format changes.

## 0.4.9

### 设置界面

- 按「选择人格、日常转述、记忆与约定、高级设置」重新组织页面，人格改为卡片选择，当前角色置前并明确标记。
- 常用开关直接可见；创建人格、人格编辑、记忆管理、模型配置和详细说明按需展开，减少初次打开时的信息量。
- 编辑器收起后保留草稿，保存失败可继续修改和重试；静默播报开启后才显示等待时长，保留自动保存和键盘操作。
- 沿用宿主主题，适配深浅色与窄屏布局；记忆列表有独立滚动范围，手动添加、后台整理和清理操作分别收纳。

### 结构化记忆

- 新增有来源、作用范围、条目版本和有效期的记忆，区分共享、人格私有与会话范围，支持偏好替换、置顶、逐条修改和删除。
- 明确的简短表达偏好可在本地及时记录；临时偏好只在对应会话使用，默认一天后失效。转述每次最多选取 5 条表达偏好或互动约定，总内容不超过 600 字符。
- 新增默认关闭的「后台整理记忆候选」，按批次使用当前转述模型整理用户短消息片段，不阻塞正文；模型结果需采纳后才生效，来源不匹配的结果不写入。
- 旧版语气纠正迁移为候选，保留来源缺失标记；语言、句长等统计不再直接推断用户希望怎样被回应。
- 重复消息、重放与重试不会重复采集；修改、删除、清空或关闭功能会取消过时任务，防止迟到结果重新写回。清空同时移除待整理内容、交接记录和近期诊断样本。

### 多人格接力基础

- 增加绑定发送角色、接收角色和会话的交接记录，支持持久化、幂等接收、版本检查与关闭。
- 交接只引用可共享的生效条目，读取时重新核对范围；人格私有互动不会自动导出，也不会被接收角色当成自己的长期经历。
- 当前提供记忆层的数据和接口基础，自动角色调度、多角色发言及宠物台词尚未接入。

### 使用与兼容

- 新增记忆与接力文档，更新设置入口、升级迁移、容量和接口说明。
- 升级后可在「记忆与约定」中检查并采纳旧版候选；后台模型整理需手动开启，会增加所选模型的用量。
- 保持 DSH `>=0.2.1-rc.3 <0.2.2-0` 兼容范围和零运行时依赖。

## 0.4.8

### 过程运行信息

- 新增默认关闭的「允许过程转述参考运行信息」，与阶段性输出改写开关放在一起。开启后，转述模型可按需调用只读函数，查询当前阶段的工具分类计数、可确认的工作性质和本会话节奏。
- 工具调用与返回分别去重，只统计相邻阶段汇报之间的新活动；只传分类、计数和标量，不传工具参数、输出正文、代码或文件路径，无法确认的信息保持未知。
- 可选补充独立显示，最多一句、40 个字符，每轮最多 3 条，不占汇报正文的长度预算，不加入正文的措辞变化评分；最终汇报不使用统计函数或由其生成的语气样例。

### 可靠性与交互

- 启动期间修改的设置优先于旧存储值；清空记忆同时清除近期诊断样本，旧记录不会在存储恢复后重新出现。
- 人格卡保存与预设操作按顺序执行，迟到的保存响应不会覆盖后续输入；切换人格前先保存草稿，保存失败时保留内容。生成预设保存失败后保留预览与名称，方便重试。
- 切换或编辑人格时清除旧语气样例，取消旧人格仍在进行的转述，避免口吻串入新人格。
- 改写须明确正常结束后才接受结果；输出被截断或缺少结束标记时保留原文。默认模型查询纳入超时与取消范围，卸载时取消转述和人设提取请求，迟到的查询结果不会触发新调用。

### 文档与分发

- 重新设计中文首页，使用纵向原文与人格版示例，补充静态插图和文档导航。
- 将详细说明拆分为使用指南、配置参考、架构与边界、开发指南和后续计划，首页保留项目介绍与快速上手。
- 明确关闭阶段性输出只跳过带工具调用的步骤；严格只改最终汇报需设置 `trigger: report`。保留 DSH `>=0.2.1-rc.3 <0.2.2-0` 的兼容范围与零运行时依赖。

## 0.4.7

### 中文

#### 兼容性

- 适配 DSH `0.2.1-rc.5`：将 `engines.dsh` 从精确版本改为兼容范围 `>=0.2.1-rc.3 <0.2.2-0`，避免新版 DSH 因版本锁定拒绝加载。
- 已在 DSH `0.2.1-rc.5` 的官方渲染器与 Cordis 集成环境中验证；本次为兼容更新，不改变现有功能。

### English

#### Compatibility

- Support DSH `0.2.1-rc.5` by widening `engines.dsh` from an exact version to `>=0.2.1-rc.3 <0.2.2-0`, so newer DSH releases are not rejected by the version lock.
- Verified against the official renderer and Cordis integration environment on DSH `0.2.1-rc.5`; this is a compatibility-only update with no behavior changes.

## 0.4.6

### 中文

#### 状态同步

- 优先通过官方 Gateway Remote 推送人格改写与开关状态，复用宿主连接，不另建 WebSocket 或 SSE 服务。
- 使用完整快照与增量更新；同一会话共享订阅，慢消费者合并更新，独立控制订阅在关闭人格后仍保持连接。
- 官方能力不可用或流打开失败等可恢复情形保留长轮询回退；认证、业务与协议错误单独处理。
- 静默播报的前台查看租约沿推送流续期，连接之间独立管理。

#### 显示与生命周期

- 完善运行中助手步骤到定稿汇报的衔接，减少等待状态与原文之间的不必要切换。
- 改善启动时的存储恢复、会话开关同步，以及插件重载后的状态一致性。
- 旧实例与较早请求的迟到响应不会覆盖新状态；卸载时释放订阅、定时器与挂载贡献。

#### 文档与分发

- 重新整理项目首页、安装方式、人格预设、原文对照、变化提示、静默播报与使用边界。
- 补充共享 Remote 描述符、浏览器实现生成与集成测试的开发说明。
- npm 包包含更新记录与架构插图，保持零运行时依赖。

**兼容与权限：** 面向 DeepSeek Harness Desktop / Web，开发基线为 `0.2.1-rc.3`。HTTP 路由默认要求认证，Remote 推送限定为 owner；公开存活探针不返回正文、会话 ID、设置或错误详情。

### English

#### State synchronization

- Prefer the official Gateway Remote stream for rewrite and switch updates, reusing the host connection without a separate WebSocket or SSE service.
- Start with a full snapshot, then deliver deltas. Share subscriptions within each session, coalesce updates for slow consumers, and keep a separate control subscription alive when persona rendering is disabled.
- Retain long-poll compatibility for recoverable capability or stream-opening failures. Handle authorization, business, and protocol errors separately.
- Renew foreground-view leases for quiet progress notices through the stream, with independent leases for each connection.

#### Rendering and lifecycle

- Improve the transition from running assistant steps to settled reports, reducing unnecessary switches between waiting states and original text.
- Improve startup storage restoration, session-switch synchronization, and state consistency across plugin reloads.
- Reject late responses from retired instances or older requests, and release subscriptions, timers, and mounted contributions on disposal.

#### Documentation and distribution

- Reorganize the project overview, installation, persona presets, original-text comparison, rewrite hints, quiet progress notices, and limitations.
- Document the shared Remote contract, browser implementation generation, and integration-test entry points.
- Include the changelog and architecture illustration in the npm package while retaining zero runtime dependencies.

**Compatibility and access:** Designed for DeepSeek Harness Desktop / Web, with `0.2.1-rc.3` as the development baseline. HTTP routes require authentication by default, and Remote streams are owner-only. The public liveness probe excludes report text, session IDs, settings, and error details.
