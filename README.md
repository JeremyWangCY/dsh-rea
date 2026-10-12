# dsh-rea

Reverse-engineering tools for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), powered by [REA](https://github.com/morluto/rea).

Inspect shipped artifacts and runtime behavior without their source: native
binaries, JavaScript/Electron apps, .NET/Java assemblies, packaged archives,
mobile bundles, and web pages. Results come back as structured **Evidence**, so
conclusions stay auditable.

## Why this plugin exists

REA ships an MCP server with **~170 tools worth ~1.9 MB of JSON Schema
(≈540k tokens)**. The harness attaches tool schemas to *every* model request, and
`@deepseek-ai/dsh-mcp-client` registers every tool a server advertises — so a
plain bridge entry for REA would spend more than half a large context window
before the conversation even starts. (REA's own `compact` schema profile removes
only ~9%.)

`dsh-rea` is a **filtering** MCP bridge. It registers a curated subset under the
`rea__` namespace:

| Tier | Tools | Schema cost | Contents |
|---|---|---|---|
| `entry` **(default)** | 9 | ~98 kB (~27k tokens) | One tool per target family: identify a target and learn what it is |
| `navigate` | +30 | ~280 kB (~78k tokens) | Reading inside a target: procedures, strings, members, bundle internals |
| `analyze` | +17 | ~319 kB (~89k tokens) | Deep correlation, comparison, JS/Electron runtime tracing |
| `all` | 170 | ~1.9 MB (~543k tokens) | REA's complete catalog — rarely what you want |

Per-tool cost is spread fairly evenly (2–45 kB each), so **count** is the lever
that works; there is no small set of heavy tools to drop.

The long tail is never out of reach: the REA CLI
(`npx -y rea-agents@latest <command>`) exposes all 170 tools **without spending
any model context**.

## Install

```bash
dsh plugin add dsh-rea
```

The plugin runs REA through `npx`, so no global install is needed. It requires a
supported Node runtime (`^22.19.0 || ^24.11.0 || >=26`); the harness's bundled
Electron runtime satisfies this.

## Configuration

Defaults require nothing. Override through your profile's `cordis.patch.yml`:

```yaml
- id: dsh-rea
  name: dsh-rea
  config:
    tools: navigate        # entry (default) | navigate | analyze | all, or an explicit name list
    version: '6.4.0'       # exact rea-agents version, pinned for stable schemas
    toolCallTimeoutMs: 300000
    env:
      REA_MCP_INPUT_SCHEMA_PROFILE: compact   # trim parameter descriptions
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to keep the plugin installed but inert |
| `tools` | `'entry'` | Tier name (`entry`/`navigate`/`analyze`/`all`), an explicit array of REA tool names, or `null` for everything |
| `version` | `'6.4.0'` | Exact `rea-agents` version; pinning keeps tool schemas stable across restarts |
| `runner` | `'npx'` | Package runner used to launch REA |
| `env` | `{}` | Extra child environment, merged over the inherited env |
| `toolCallTimeoutMs` | `300000` | Per-call timeout; native analysis can run long |
| `failOnStartupError` | `false` | Reject activation when REA fails to start, instead of degrading to no tools |

## Usage

Registered tools use the `rea__` prefix and route by target:

| Target | First tool |
|---|---|
| ASAR or extracted JavaScript/Electron tree | `rea__analyze_javascript_application` |
| Native executable | `rea__open_binary`, then `rea__binary_overview` |
| Archive, ZIP/APK/IPA/MSIX, or DMG | `rea__open_binary`, then `rea__inspect_artifact` |
| Managed PE/CLI assembly | `rea__inspect_managed_artifact` |
| Browser page already open | `rea__list_browser_targets` |
| Electron runtime already open | `rea__list_electron_targets` |

REA reports each result as an `evidence_id`. When a response is too large for
the stdio budget, REA says so and points at `rea__export_evidence_bundle` (in the
default tier) to retrieve the retained records.

## Caveats

- **Native analysis needs an external engine.** Hopper, Ghidra, or IDA must be
  installed separately. Static JavaScript analysis needs none.
- **Large analyses take time and can exceed REA's stdio response budget.** That
  is REA's own limit, not the bridge's; use the evidence-bundle tools or the CLI
  for those.
- Tool names are pinned to the configured `version`. After bumping it, re-check
  that your `tools` list still matches what REA advertises — unknown names are
  logged and skipped, never fatal.
- Commercial decompilers (IDA Pro/Hex-Rays, Hopper, JEB) require your own legal
  license. This plugin grants none.

## Credits

REA is the work of [morluto](https://github.com/morluto/rea) and its contributors
(MIT). This plugin is an independent DSH bridge; it bundles no REA source.
