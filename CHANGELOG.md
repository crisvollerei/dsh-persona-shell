# 更新记录 / Changelog

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
