# Codex / Claude 双向桌面互通验证

验证日期：2026-10-10（上海时间）。版本：Agent Talk 0.5.0。
环境：macOS，本机 Codex Desktop 26.1007.21159（build 20052）；Claude Desktop 2.31226.1，其 Code 工作进程版本为 2.1.295。以下为实际原生桌面对话验证，非模拟接口结果。

| 方向 | 实际操作 | 结果 |
|---|---|---|
| Codex → Claude | Codex 调用 `talk_create(app=claude)`；用 `talk_send` 派发 ALPHA 任务；Claude 提问 BLUE/GREEN，问题自动回传；Codex 回答 BLUE；Claude 保留口令并完成任务 | PASS：`E2E_OCT10_ALPHA BLUE E2E_ALPHA_RESULT` |
| Claude → Codex | Claude 调用 `talk_create(app=codex)`；派发 BETA 任务；Codex 提问 GREEN/BLUE；Claude 回答 GREEN；Codex 保留口令并完成任务，最终结果自动回到 Claude | PASS：`E2E_OCT10_BETA GREEN E2E_BETA_RESULT` |

已核对两个 Codex 会话的客户端数据库来源为 `Codex Desktop`、目录精确匹配；Claude 已核对真实进程登记、原生桌面任务、目录和最终回复。重复调用原始创建请求返回同一原生会话，没有再次创建。临时验证客户端退出后，Claude 仍可通过已连接的 Codex MCP 私有转接读取项目列表。测试自动回传已关闭，测试会话在桥接中标记完成，原客户端对话保留供本机复查。

## 联调和审查修复

- 识别 Claude 的 `claude-desktop-3p` 入口与 busy 状态；发送真实来源权限类别，未修改客户端权限模式。
- 新版 Codex 要求签名运行时和 Codex 进程来源；Claude 通过 Codex MCP 的私有本机转接创建对话，避免另启 app-server 操作桌面会话。
- Claude 新建等待异步输入完整保留后发送，保护已有草稿，串行处理新建；确定尚未提交时才允许原请求恢复，结果不明时只读回原会话。
- 早期辅助测试客户端过早退出导致原生回信地址失效，接收模型曾将一条无害算术问题转发到另一个会话。已增加精确别名和回传目标指引，明确禁止使用原生 ListAgents/SendMessage 猜测接收方；正式测试全部使用专用会话。该指引不等于禁用模型拥有的原生工具。
- 过滤 Codex 初始化注入的 AGENTS/environment 材料，避免当作用户介入回传；已用真实记录验证过滤和创建标记恢复。这个最后的解析修补使用真实记录及冒烟测试验证，未重新跑一遍完整双向多轮流程。
- 审查修复 DSH 直接消息在分离队列中因 SQL NULL 判断被漏掉的问题；桌面路由类型在同一事务写入，防止旧 MCP 进程短暂误处理；新建预检查失败明确标记 `not_submitted`。

## 检查与实际限制

`npm run check`、`npm run smoke`、`git diff --check` 通过。复用现有冒烟文件，覆盖协议分片、断开不重发、转接操作白名单、防回声、sender 防重、初始化材料过滤、DSH 排队兼容和原子路由类型。没有新增依赖。

两客户端须运行，至少一个 Codex MCP 保持连接；两个客户端使用同一源码目录和本地 SQLite。Codex MCP 须转发 `CODEX_APP_TOOLS_PIPE_PATH`、`CODEX_THREAD_ID`，并使用桌面端随附的签名 Node。目录须已保存/信任；Claude 侧须已有活跃 Code 会话且项目在侧栏可见，新建依赖现有 macOS 辅助功能/自动化权限。更新后旧聊天须重连 MCP，或新建聊天加载新工具定义。

未验证其他操作系统、其他客户端版本、长时间离线补传以及所有原生停止/断线并发形式。Claude 原客户端可能返回 `held`，这表示暂存，不能重发。原生接口不是厂商承诺稳定的公共 API，客户端升级后需重新核验。

本文件已脱敏；凭据、配置备份、本地数据库、完整对话和本机对话 ID 不提交到 GitHub。
