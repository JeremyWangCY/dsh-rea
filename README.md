# dsh-rea

Full [REA](https://github.com/morluto/rea) 6.4.0 MCP tools and its original version-matched skill for DeepSeek Harness. English | [中文](README.zh.md)

## What is preserved

- All **170 upstream tools**, including navigation, decompilation, Android/ADB, managed code, JavaScript/Electron and runtime analysis. No invented entry/navigate/analyze tiers.
- Original input schemas and descriptions, with stable DSH names `mcp__rea__<upstream-name>`.
- The official `@deepseek-ai/dsh-mcp-client` handles pagination, notifications, cancellation, lifecycle, output validation and attachment projection.
- Original `reverse-engineer-anything` skill v37, tool_count=170 and all six references. The plugin registers the package's skill with its own resource directory; it does not overwrite Codex/user skills.
- Original stateful upstream MCP process and complete Evidence `content`/`structuredContent`. No result summaries or reconstructed IDs.

REA is an exact npm dependency, not a reimplementation. Native engines and commercial licenses remain bring-your-own, exactly as upstream.

## Install

The package has not been published to npm. Install from the repository using DSH's plugin manager, or select a packaged release tarball when available:

```text
github:JeremyWangCY/dsh-rea
```

For local development, install the absolute directory of this checkout through the plugin manager. Use the currently active profile; Web UI does not necessarily mean the `web` profile (desktop can host the same UI).

## Configuration

The bundle inserts the host plugin. Defaults expose everything and leave DSH's native/PTC presentation untouched:

```yaml
- id: dsh-rea
  config:
    serverName: rea
    toolCallTimeoutMs: 300000
    # Optional supported standalone Node executable:
    # nodeCommand: 'C:\path\to\node.exe'
```

| Field | Default | Meaning |
|---|---|---|
| enabled | true | Enable the plugin |
| serverName | rea | Official bridge namespace |
| tools | all | Compatibility marker; subsets are no longer supported |
| nodeCommand | empty | Host executable; Electron uses `ELECTRON_RUN_AS_NODE=1`. Set an explicit supported Node if child analysis workers cannot use the host executable |
| env | {} | Explicit REA provider environment; official bridge scrubs inherited credential-shaped/DSH variables |
| toolCallTimeoutMs | 300000 | MCP call timeout; not an assurance that the outer agent/PTC deadline is longer |
| failOnStartupError | true | Report startup failure rather than silently exposing an empty tool set |

Supported Node range: `^22.19.0 || ^24.11.0 || >=26.0.0`; 23/25 are unsupported. No runtime or analysis engine is installed/upgraded by plugin activation. Existing unrelated approval/preset settings are not changed. Automatic reconnection is disabled deliberately: a new REA process loses target/provider/retained Evidence state; reload explicitly after a disconnect.

### Native versus PTC

All tools remain registered in both modes. PTC belongs to DSH's tools/agent preset, not REA; the plugin does not switch every other tool into PTC.

Measured in an isolated real Cordis deployment on this machine:

| Presentation | Model-side tool JSON | Generated SDK text |
|---|---:|---:|
| native, all 170 | 436,594 bytes | 0 |
| PTC, `run_code` only | 944 bytes | 86,633 bytes |

These are **bytes, not tokenizer counts**. The previous v0.1 claim of ~543k input tokens incorrectly counted MCP output schemas as model input. PTC is not zero-context; SDK text is in the prompt. Its default worker wall limit is 600s, compute limit 60s and output limit 64MiB. Only returned/printed values become the outer result, so return complete Evidence when needed. PTC and native preserve tool results, but they are different model interfaces and are not proven to produce identical answers.

Use the original skill's routing, Evidence and provider-recovery instructions. REA CLI JSON also preserves full Evidence IDs; unlike long-lived MCP it is normally one-shot and does not retain a provider/target across commands. CLI output still consumes context if fed back to the model.

## Verification and limits

`verify/integration.mjs` runs the real Cordis ToolRuntime, original upstream MCP and DSH worker-thread PTC, then deeply compares results. Covered: all 170 names/descriptions/input schemas, original skill, JS analysis and data-flow tracing, retained-reference view, Evidence bundle listing, a one-record offline HAR, one-member ZIP lifecycle/inventory, upstream errors, pre-dispatch cancellation, disposal, explicit startup failure. Install dependencies with a supported Node and pnpm, then run `pnpm test` and `pnpm verify`. Optional `DSH_REA_TEST_MODULE_ROOT` points at an installed DSH module root for exercising those exact Host services; by default the checkout's test dependencies are used. See `verification/integration-report.json` in the source checkout.

Not claimed: all 170 operations executed; native decompilers/ADB/JEB/browser capture equivalence; mid-flight expensive-operation cancellation; identical LLM answers; every model provider's schema limits. External providers require task-specific verification.

DSH's official MCP bridge currently exposes tools, not a UI for REA's six optional MCP prompts or prompt argument completions. They are investigation-start templates rather than analysis tools; the original skill remains available. This protocol/UI difference is disclosed, not called full client parity. Raw upstream prompt/completion availability is separately inspectable via MCP. The official bridge also does not copy MCP annotations to ToolRuntime metadata; required-task execution would be unsupported. See [the bounded verification report](verification/README.md) for environment, methods and exact limitations.

## Migration from v0.1

Remove old `tools: entry/navigate/analyze`, `runner` and `version` overrides. Version comes from the exact dependency; all tools are restored, public prefix changes from `rea__` to `mcp__rea__`. New naming matches DSH's official bridge.

## License

This adapter is MIT. REA is by morluto and contributors, MIT, included as a pinned dependency with its upstream license. Third-party tools retain their own licenses.
