# 受控联网检索

DSSuperAgent 主会话不注册联网工具；需要实时或外部信息时，应创建/续接 worker 任务，由 worker 使用 `orchestrator_web_search` 和 `orchestrator_web_fetch`。Company Agent 每次搜索或读取网页前检查控制台开关；搜索请求由自托管 SearXNG 执行，网页读取由 DSH fetch 执行。结果包含来源网址、标题、摘要和检索时间，worker 应引用来源。上游大模型网关继续负责模型推理，不提供或替代搜索后端。

Company Agent 事件以当前消息判断联网需求；历史上下文中的“不能联网”不能覆盖新的实时请求。需要联网时必须形成 `propose_work` 并交给带 `dsh.task` 的 worker，QQ 回复使用 `group_update`。

网页读取使用 `orchestrator_web_fetch`：先通过 Company Agent `/internal/web/authorize`，再调用 DSH 的 HTTP fetch 能力。DSH 原生 `tool-web` 搜索和读取关闭，确保 Agent 无法绕过 Company Agent 的权限检查。DSH 本体没有修改。

DSSuperAgent 进程需要设置：

```text
COMPANY_AGENT_WEB_GATE_URL=http://127.0.0.1:28767/internal/web/authorize
COMPANY_AGENT_WEB_GATE_API_KEY=<与 Company Agent 相同的桥接密钥；双方均使用 loopback 时可以留空>
```

搜索失败含义：

- `webSearchDisabled`：控制台关闭了 DSSuperAgent worker 联网权限。主会话没有联网工具，无法自行绕过此开关。
- `webSearchUnavailable`：Company Agent 网关不可达。
- `webSearchFailed`：SearXNG 不可达或返回了无效响应。
- `webFetchFailed`：网页读取服务失败。

DSH 任务自己的联网开关仍独立，关闭外网不影响 AnythingLLM 资料库检索。搜索结果必须来自实际后端响应；错误响应不会被伪装成搜索结果。
