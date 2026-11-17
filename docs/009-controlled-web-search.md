# 受控联网检索

DSSuperAgent 不直接开放 DSH 原生 `web_search` / `web_fetch` 工具。主 Session 和 Executor Session 使用两个 Company Agent 工具：

- `orchestrator_web_search`：搜索当前网页信息，返回来源 URL、标题、摘要、发布时间和检索时间。
- `orchestrator_web_fetch`：读取单个 HTTP(S) 页面，优先使用搜索结果中的 URL。

每次工具调用先向 `COMPANY_AGENT_WEB_GATE_URL` 发送授权请求。Company Agent 从控制库读取 `dssuperagent_web_search_enabled`；关闭时返回 403，Agent 不会访问外网；打开时才调用 DSH 官方 `ctx.web` seam。这样不需要重启 DSSuperAgent，下一次调用即可看到开关变化。

DSH 本体没有被修改。DSH 官方 Web seam 和提供方仍由 DSH 自己加载；本项目只增加 Company Agent 授权边界和 DSSuperAgent 的薄工具适配器。DSSuperAgent 的运行环境需要配置：

```text
COMPANY_AGENT_WEB_GATE_URL=http://127.0.0.1:8767/internal/web/authorize
COMPANY_AGENT_WEB_GATE_API_KEY=<与 Company Agent 相同的 32+ 字符密钥；loopback 可留空>
```

Worker profile 中的原生 `tool-web` 已关闭，避免绕过 Company Agent；Company Agent 启动的 DSH 执行仍由 `AGENT_WEB_SEARCH_ENABLED` 单独控制。资料库检索和外部联网检索是两套权限，关闭外网不会影响 AnythingLLM 查询。

## 失败含义

- `webSearchDisabled`：控制台关闭了 DSSuperAgent 联网权限。
- `webSearchUnavailable`：网关不可达，或 DSH 没有可用的 Web provider。
- `webSearchFailed` / `webFetchFailed`：授权通过，但 DSH Web provider 请求失败。
