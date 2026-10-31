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

## 状态同步开发与联调

`lib/remote-contract.js` 是 Host/Client 共用的严格 Remote 描述符与边界校验；`lib/client-transport.js` 管理订阅生命周期。为保持零运行时依赖，当前采用公共描述符/codec 接口，不引入 Typert TypeScript 生成工具链。浏览器副本由以下脚本嵌入现有 `client.js`，测试会检查副本与源实现逐字一致：

```bash
node scripts/build-client-sync.mjs
node scripts/build-client-sync.mjs --check
```

可选集成脚本位于 `test/integration/`，不属于默认离线测试，也不安装项目运行时依赖：

- `remote-runtime.mjs --deps <测试依赖目录/package.json>`：使用脚本锁定的 `0.2.1-rc.3` Cordis、Typert Registry、Gateway、Connection 和流监督器，验证开关推送、重连、Host 独立重载、注入作用域、卸载及 owner-only 边界；模型为禁止调用的替身。
- `desktop-runtime.mjs --executable <已安装客户端.exe> --browser-deps <playwright/package.json>`：使用临时 `DSH_HOME` 和临时 Electron 用户目录运行官方 Desktop，检查推送、开关、空闲请求、页面重载和连接恢复；不读取现有密钥或会话，不调用真实模型。
- `process-runtime.mjs --deps <SDK 测试依赖目录/package.json>`：用已发布的 `0.2.1-rc.x` LLM SDK 核对增量/完整工具块、原生 assistant/tool 消息和提供方重放信息；不调用真实模型。
- `official-renderer.mjs`、`review-browser.mjs`、`comparison-browser.mjs`、`progress-runtime.mjs`：官方渲染、布局和播报生命周期的独立回归；具体依赖参数见各脚本开头。

`/persona-shell/ping` 的 `stateSync` 只公开流的数量统计与客户端状态枚举，供存活与连接排查。官方参考：[API Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.zh.md) · [添加 Remote API](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-remote-api.zh.md)。

## 版本约定

未发布前的日常开发不提升包版本号；准备发布时递增补丁号（`0.0.1`），不跳 minor。

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
  pack.js             人格卡归一化与默认人格
  preset.js           从人设提示词提取人格卡
  memory.js           跨会话观察与按预设保存的风格纠正
  config.js           默认配置与 Standard Schema
  store.js            结果、预设与风格记忆的存储
  remote-contract.js  Host/Client 共享的严格 Remote 边界
  state-stream.js     Host 快照、增量与合并通知
  client-transport.js 官方流监督、订阅引用计数、兼容回退与续租
scripts/              共享状态实现的浏览器嵌入与一致性检查
locale/               中文与英文插件文案
test/                 离线与可选集成测试
```

## 文档与分发

`README.md` 负责项目介绍和快速上手；`docs/` 保存使用、配置、架构与开发说明，`CHANGELOG.md` 记录版本变化。未实现的方向单列在[后续计划](./roadmap.md)。

首页插图位于 `docs/assets/`，两层架构图位于 `docs/layers.svg`。它们是静态 SVG，使用本地字体回退，无远程字体或脚本依赖；调整插图时保留标题、描述和正文中的文字说明。

`package.json` 的 `files` 显式包含文档与插图。调整文档位置后检查相对链接，并通过 `npm pack --dry-run` 确认分发内容。

---

[架构与边界](./architecture.md) · [后续计划](./roadmap.md) · [返回首页](../README.md)
