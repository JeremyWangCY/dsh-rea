# dsh-rea

Full [REA](https://github.com/morluto/rea) 6.7.0 MCP tools and its original version-matched skill for DeepSeek Harness. English | [中文](README.zh.md)

**Lazy by default:** the 207 tool schemas and the skill stay out of a request until you run `/rea` — 775,022 bytes per request saved in native mode (~67 KB in PTC) when they are not needed.

## Lazy exposure (default since v0.4)

Tools and the skill are **per-agent lazily visible**; the protocol and the process do not change:

- The MCP connection, the single REA process, all six original prompts and completions are **always live** — the `/` menu works whether or not a session has revealed the catalog.
- Each agent starts with a `tools.restrict({ deny })` mask naming every current `mcp__rea__*` tool. Native schemas and the generated PTC SDK prompt are both projected from the same scope view, so both lose the catalog together.
- The skill is registered once at reveal time and released again when the last revealed session hides the catalog, so it costs nothing in sessions that never reveal — and stops costing anything after `/rea off`.
- A bridge re-sync (`notifications/tools/list_changed`) rebuilds every mask, so a new tool generation cannot slip through; agents that already revealed are never re-masked mid-task.
- A resumed session is judged from the `command/run` records already in its log: the records are replayed in order, so the last `/rea` or `/rea off` wins, `/rea status` records are ignored, and a session where you ran `/rea` yesterday is not hidden again today. An unreadable history means **hidden** — the catalogue is never revealed by accident.

### `/rea` is the switch; keywords are not

```text
/rea                      reveal only, then wait for the request
/rea look at this apk      reveal, and forward that text to the model verbatim
/rea on                    same as a bare /rea
/rea status                report whether the catalog is hidden or revealed
/rea off                   hide the catalog again for this session
```

The command reveals first, then queues everything after `/rea` as an **ordinary user message** — a resolved command never reaches the model, so not forwarding it would silently swallow your request.

`/rea off` re-masks the tools immediately and is durable across a reload: a session that ends hidden stays hidden. It only affects the session that ran it.

**Why not infer from keywords:** inference is a guess, and a wrong guess costs the whole catalog (530 KB in native mode). It is also wrong precisely where it is most expensive — discussing this gate necessarily names its trigger words. `/rea` is the user saying it outright.

A keyword path still exists, opt-in:

```yaml
- id: dsh-rea
  config:
    keywordUnlock: true
```

Return to the previous always-on catalogue:

```yaml
- id: dsh-rea
  config:
    exposure: always
```
## What is preserved

- All **207 upstream tools**, including navigation, decompilation, Android/ADB, managed code, JavaScript/Electron and runtime analysis. No invented entry/navigate/analyze tiers.
- Original input schemas and descriptions, with stable DSH names `mcp__rea__<upstream-name>`.
- The official `@deepseek-ai/dsh-mcp-client` handles pagination, notifications, cancellation, lifecycle, output validation and attachment projection.
- Original `reverse-engineer-anything` skill, its upstream `tool_count` and all six references. The plugin registers the package's skill with its own resource directory; it does not overwrite Codex/user skills.
- Original stateful upstream MCP process and complete Evidence `content`/`structuredContent`. No result summaries or reconstructed IDs.
- All **six original MCP prompts** with their 25 arguments and the original dynamic completions, reachable from the composer's `/` menu on the *same* REA Client, process and analysis session as the 207 tools.

REA is an exact npm dependency, not a reimplementation. Native engines and commercial licenses remain bring-your-own, exactly as upstream.

## Prompt templates in the `/` menu

The six original prompts enter through the composer's own `/` menu, under the `rea` group (`/rea:investigate_feature`, `/rea:compare_application_versions`, `/rea:verify_reconstruction`, `/rea:trace_crash`, `/rea:audit_residual_unknowns`, `/rea:prepare_bounded_process_capture`) — the surface a Codex user already knows, where Codex exposes these same MCP prompts. **No extra button or permanent control is added to the composer.**

Picking an entry opens that template's argument form: the original argument descriptions, upstream argument completions (target documents, providers, procedures, retained Evidence, captures, manifests, occurrences, unresolved unknowns) and an exact-text preview you can insert into the draft.

Fidelity rules of that panel:

- Discovery and resolution are both originals: the menu lists `prompts/list`, the form calls `prompts/get`, and completions call `completion/complete` on the connection the tools already use — no second REA process, no rewritten templates, no cached or fabricated suggestions.
- A pick returns `handled`: the slash pipeline inserts and rewrites nothing, so choosing a template changes no draft text.
- Preview never executes analysis; every tool call stays a separate, explicit model decision.
- Insertion is a plain draft write. The panel never submits, never sends and never selects a target; you edit or send the draft yourself.
- A generation guard rejects a render whose answer arrives after the connection changed, so a stale template can never be inserted.
- The menu group is Web-only. CLI/headless profiles follow the same lazy rules; only the `/` group is absent.

Because DSH caches each package's client metadata for the lifetime of a Host process, adding this entry requires **one DSH restart** after upgrading: a running Host that already mounted `dsh-rea` before this version has cached it as a host-only package and will not serve the new bundle until it restarts. No configuration change is needed.

## Install

The package has not been published to npm. Install from the repository using DSH's plugin manager, or select a packaged release tarball when available:

```text
github:JeremyWangCY/dsh-rea
```

For local development, install the absolute directory of this checkout through the plugin manager. Use the currently active profile; Web UI does not necessarily mean the `web` profile (desktop can host the same UI).

## Configuration

The bundle inserts the host plugin. Defaults load the catalog on demand and leave DSH's native/PTC presentation untouched:

```yaml
- id: dsh-rea
  config:
    exposure: lazy
    serverName: rea
    toolCallTimeoutMs: 300000
    # Optional supported standalone Node executable:
    # nodeCommand: 'C:\path\to\node.exe'
```

| Field | Default | Meaning |
|---|---|---|
| enabled | true | Enable the plugin |
| exposure | lazy | `lazy` exposes the catalogue per agent and only after `/rea`; `always` restores the v0.3 always-on catalogue |
| keywordUnlock | false | Also let a real user message reveal the catalogue by mentioning reverse engineering. Off by default; see above |
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
| native, all 207 | 775,022 bytes | 0 |
| PTC, `run_code` only | 944 bytes | 86,633 bytes |

These are **bytes, not tokenizer counts**. The previous v0.1 claim of ~543k input tokens incorrectly counted MCP output schemas as model input. PTC is not zero-context; SDK text is in the prompt. Its default worker wall limit is 600s, compute limit 60s and output limit 64MiB. Only returned/printed values become the outer result, so return complete Evidence when needed. PTC and native preserve tool results, but they are different model interfaces and are not proven to produce identical answers.

Use the original skill's routing, Evidence and provider-recovery instructions. REA CLI JSON also preserves full Evidence IDs; unlike long-lived MCP it is normally one-shot and does not retain a provider/target across commands. CLI output still consumes context if fed back to the model.

## Verification and limits

`verify/integration.mjs` runs the real Cordis ToolRuntime, original upstream MCP and DSH worker-thread PTC, then deeply compares results. Covered: every upstream name/description/input schema, original skill, the six original prompt metadata sets and their rendered messages, an original provider completion, JS analysis and data-flow tracing, retained-reference view, Evidence bundle listing, a one-record offline HAR, one-member ZIP lifecycle/inventory, upstream errors, pre-dispatch cancellation, disposal, explicit startup failure. `test/client.test.mjs` loads the real browser bundle against a minimal React/DOM harness and drives the actual `/` source: idle silence (the session slot renders nothing and no request is sent), source registration, candidate filtering, a `handled` pick that writes no draft, argument gating, completion payloads, exact preview text, draft-preserving insertion through `setDraft` only, error surfacing, and the post-upgrade restart hint. `verify/connection.mjs` mounts the real installed `WebServer` + `Connection` and speaks the real wire: 401 without the browser session, then `prompts/list`/`get`/`complete` deep-equal to a direct MCP client, plus envelope, content-type, Host-fence and disposal refusals. `test/gate.test.mjs` covers per-agent masking, re-sync, resume behaviour and the default "keywords do not reveal" policy; `test/command.test.mjs` covers `/rea` directive parsing, forwarding and failure handling. `verify/lazy-exposure.mjs` mounts the real `dsh-system-prompt`/`dsh-tools`/`dsh-skill` services and measures that a gated agent's assembly carries zero `mcp__rea__` schemas while the bridge keeps its full generation installed. `pnpm test` runs 68 unit/harness tests; `pnpm verify` runs the differential suite and `pnpm verify:lazy` the 7-check lazy-exposure suite. Install dependencies with a supported Node and pnpm first. Optional `DSH_REA_TEST_MODULE_ROOT` points at an installed DSH module root for exercising those exact Host services; by default the checkout's test dependencies are used. See `verification/integration-report.json` in the source checkout.

Not claimed: all upstream operations executed; native decompilers/ADB/JEB/browser capture equivalence; mid-flight expensive-operation cancellation; identical LLM answers; every model provider's schema limits; exhaustive completion coverage for every external provider. External providers require task-specific verification.

The official `@deepseek-ai/dsh-mcp-client` exposes no shared-connection hook, so `lib/vendor/mcp-bridge.js` is a verbatim MIT copy of that bridge (upstream SHA-256 recorded in its header) with exactly one reviewed local change: an optional fourth `onClient` argument. Tool registration, transport, reconnect, error and disposal behavior are byte-identical to upstream, and `test/plugin.test.mjs` re-derives and compares the whole file so it cannot silently drift. The official bridge also does not copy MCP annotations to ToolRuntime metadata; required-task execution would be unsupported. See [the bounded verification report](verification/README.md) for environment, methods and exact limitations.

## Migration from v0.1

Remove old `tools: entry/navigate/analyze`, `runner` and `version` overrides. Version comes from the exact dependency; all tools are restored, public prefix changes from `rea__` to `mcp__rea__`. New naming matches DSH's official bridge.

## Upgrading the pinned REA release

The dependency is an exact pin, so a new REA release is adopted by changing that one
line and re-verifying — no adapter source change is expected, because the plugin reads
the version and the catalog size from the installed package instead of carrying literals:

```sh
pnpm add rea-agents@<new-version>
node verify/measure.mjs     # regenerates verification/schema-measurement.json
pnpm test && pnpm verify && pnpm verify:lazy
```

Then update the version, tool count, prompt-argument count and byte figures in
`README.md`, `README.zh.md` and `verification/README.md`. `pnpm verify` derives the
count itself, so a catalog change surfaces as a failure in the deep comparison rather
than as a silently stale document.

## License

This adapter is MIT. REA is by morluto and contributors, MIT, included as a pinned dependency with its upstream license. Third-party tools retain their own licenses.
