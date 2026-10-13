# Original Codex registration versus DSH adapter

Baseline: the installed npm release `rea-agents@6.4.0`, not an assumed model/client behavior.

| Upstream Codex setup behavior | DSH equivalent / difference |
|---|---|
| Persistent MCP entry named `rea` in `CODEX_HOME` or `~/.codex/config.toml` | DSH bundle/Loader entry named `dsh-rea`; MCP server namespace defaults to `rea` |
| Pinned `npx -y rea-agents@6.4.0 mcp`; Windows command runner uses `cmd.exe /d /c` | Exact npm dependency 6.4.0, absolute installed `scripts/rea.mjs` launched with Node; avoids repeated network resolution |
| Direct Windows launcher uses `process.execPath`, absolute launcher, `mcp` | Same launcher entrypoint and subcommand; explicit standalone Node supported for Electron Hosts |
| Original MCP process owns analysis provider, target and retained Evidence | Same original process; no one-shot CLI substitution; automatic reconnect disabled to avoid silent state replacement |
| Version-matched upstream Skill and six references installed under agent skill directories (fallback `~/.agents/skills`) | Same package Skill/body/references registered with DSH Skill service and original resource directory; no Codex config or filesystem skill writes |
| All 170 upstream tools discovered through MCP | All 170 discovered and registered through official DSH bridge; names become `mcp__rea__<raw-name>` |
| Client's own UI/model serialization and context behavior | Real native/PTC assembly measured; not assumed to match Codex compaction, model reasoning or client UI |
| Explicit configured environment forwarded | Explicit environment forwarded; DSH scrubs inherited credential-shaped/DSH variables, so inheritance differs |
| MCP prompts and completions exposed by server | Original server still provides them; DSH official tools bridge has no corresponding UI |

The adapter keeps business logic in the original REA package. The client-specific namespace, error wrapper, environment inheritance, metadata and presentation are explicitly separate from analysis-result parity. The differential tests compare both clients on the same target and same release, including retained-state use.
