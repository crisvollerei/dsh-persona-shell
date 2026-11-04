# 更新记录 / Changelog

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
