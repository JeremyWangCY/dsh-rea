# Differential verification of dsh-rea 0.3.0

## Conclusion

The plugin launches the **unchanged pinned `rea-agents@6.4.0` MCP executable** and mounts its complete tool catalog through DSH's official MCP bridge. It does not rewrite analysis algorithms or substitute CLI calls. The verified tool input contracts and deterministic result envelopes match the upstream server, and the six original prompts plus an original argument completion match the same server over the plugin's own shared connection. This is **bounded adapter parity, not a claim that every engine and LLM answer is equivalent**.

## Reproduce

Use Node `^22.19.0 || ^24.11.0 || >=26.0.0`:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm verify
pnpm verify:connection
node verify/measure.mjs
```

`DSH_REA_TEST_MODULE_ROOT` optionally selects an installed DSH module root for Cordis/system-prompt/tools/skills/worker services; otherwise checkout dependencies are used. Both clients run the same installed upstream package. Fixtures are regenerated deterministically by the test. Evidence identities include absolute source paths, so IDs on another machine may differ; each run compares both sides on that machine.

The desktop application this adapter targets stages its packages under `%APPDATA%\com.jeremy.deepx-workbench\runtime\node_modules`, and that composition is **`@deepseek-ai/dsh*` 0.1.5-rc.3 throughout** (`dsh-mcp-client`, `dsh-client-connection`, `dsh-client-modules`, `dsh-host-webserver`, `dsh-tools`, `dsh-skill`, `dsh-code-runtime-worker-thread`, `cordis` 4.0.2). Pointing `DSH_REA_TEST_MODULE_ROOT` at that directory runs the same comparison against the exact installed Host module set, so the tested service versions and the running service versions are the same release.

The check-in also pins the host-side contract, and the live Host settled it the hard way. `ctx.connection.rpc.handle(channel, handler)` is **not** usable by a third-party plugin: `HostConnectionService.register` registers its route through the Connection plugin's own Context (`owner.webServer`), and the loader entry only injects `[webRuntime]`, so the call throws `cannot get property "webServer" without inject` and **fails the whole plugin activation** — observed as `include:dsh-rea` `fiberPhase: failed` with no REA process alive. The shared `/api` interceptor is unavailable as well: the Typert gateway registers it and the registry rejects a second one. This plugin therefore registers a plain `webServer` prefix route and applies the same fence itself through the public `ctx.connection.requestRejection(request)` (Host/Origin policy first, then the browser session cookie), emitting the `client-request`/`server-response` envelopes that the browser caller already validates — checked in `verify/connection.mjs`, which mounts the Connection plugin exactly as production does and validates each response with the caller's own `serverResponseSchema`.

## Method and results

- Real SDK reference client → upstream stdio MCP.
- Real Cordis host → dsh-rea → official DSH MCP bridge → separate upstream stdio MCP.
- Second pass through the real DSH worker-thread `run_code` interface.
- Complete `content` and `structuredContent` deep comparison, not selected fields or mocks.
- **35 checks passed** in the checked-in integration report; **13 unit/harness tests passed**; **11 real-HTTP checks passed** in `verify/connection.mjs`.
- All **170 names, descriptions and input schemas** compared.
- Original Skill v37 body, metadata, resource directory and six references checked.
- The plugin's prompt RPC is compared against the reference client for all six prompt metadata sets, all six rendered message bodies and one original `provider_id` completion, in both presentation modes.
- `verify/connection.mjs` mounts the installed `WebServer` + `Connection` + this plugin and speaks the real wire: 401 before a browser session exists, then `prompts/list`/`get`/`complete` deep-equal to a direct MCP client, plus correlation-id echo, endpoint/method mismatch, non-JSON content type, an unknown endpoint inside the channel, an untrusted `Host` header, an invalid envelope, and channel removal on disposal.
- The real browser bundle is loaded against a minimal React/DOM harness and drives the actual `/` source: idle silence, source registration, candidate filtering, a `handled` pick that writes no draft, required-argument gating, completion payload, exact preview text, draft-preserving insertion through `setDraft`, error surfacing and the post-upgrade restart hint.
- JS fixture includes fetch/header, child-process, event, closure and timer syntax. Analysis and retained data-flow trace compared.
- Retained Evidence view and bundle listing compared; reference producer is rerun per mode because closing an upstream target clears retained evidence.
- Offline HAR contains one HTTP transaction, and ZIP contains one text member. No fixture application code or recorded URL is executed/fetched.
- Missing-file upstream error, pre-dispatch cancellation, post-cancellation liveness, scoped tool disposal and missing-launcher startup failure tested.

On the actual desktop profile, `include:dsh-rea` was reported `active`, the registered Skill resolved to the pinned package's own directory, and an actual model-callable JS analysis returned the same parent Evidence ID as the reference run: `ev_cc1622aee4367bd2e6bcd144c2cfc5bc6991c9ae30ab562d6b80fbc3b1c4b047`. Retained view calls also succeeded in that session. Local activation used an existing directory link and explicit standalone Node after the plugin manager's unrelated optional-dependency downloads timed out; this is not proof of a clean registry installation. Package packing was separately checked.

## Actual model presentation

| Mode | Wire tools | Tool JSON bytes | Generated SDK text bytes | Assembled prompt JSON bytes |
|---|---:|---:|---:|---:|
| native | 170 | 436594 | 0 | 436826 |
| PTC | 1 (`run_code`) | 944 | 86633 | 89095 |

Counts describe an isolated deployment containing REA, not all tools in the desktop profile. **Bytes are not tokens.** MCP output schemas (1494071 bytes) are not model function input schemas. PTC SDK text still costs context; the bridge registers all 170 tools regardless of model presentation mode.

## Important differences and untested boundaries

1. No end-to-end Ghidra/IDA/Hopper/JEB/JADX/ADB, live browser/Electron, firmware or image attachment verification was performed. Availability remains exactly upstream-dependent; no engines were installed by the adapter.
2. Only pre-dispatch cancellation was tested, not long-running cancellation, hard timeout or server-loss recovery. Automatic reconnection is disabled to avoid silently replacing retained state with a fresh server.
3. The official bridge preserves result payloads, but does not copy MCP annotations into ToolRuntime metadata. An execution mode requiring MCP tasks would not be callable through this bridge. The prompt/completions UI lives in this plugin's own browser bundle; that surface was exercised with a DOM harness against the real bundle, not yet against a restarted live Host, because DSH caches a package's client metadata for the lifetime of a Host process.
4. Official DSH subprocess launch scrubs inherited credential-shaped/DSH variables. Explicit REA environment values are forwarded; users must explicitly configure relevant provider variables. Codex process inheritance is not assumed identical.
5. PTC surfaces errors as `ToolCallError` rather than raw MCP `isError`; the tested upstream message remains available.
6. Model inference quality, provider schema acceptance limits and full client/UI equivalence are **not** proven by transport comparison. Completion parity is demonstrated for one provider-independent completion kind; completions requiring a specific external engine or retained provider record are not exhaustively covered.
7. The published peer range includes DSH 0.2.0-rc.2 because this desktop runtime activated the adapter, but the isolated differential suite's checked-in dependencies target the tested 0.1.5-rc.3 services. Version-specific integration should be rerun on a new Host. The installed desktop composition itself is 0.1.5-rc.3, and the suite was also run against that exact module set; a future Host that adopts the newer `authority`-carrying RPC signature is covered by the same call.
9. The vendored bridge is verified as *upstream bytes plus exactly the documented patch* by re-deriving and comparing the whole file. That does not make it immune to future upstream change: `verify/vendor-bridge.mjs` refuses to run against any other upstream version until the patch is reviewed.
10. The live GUI control was not confirmed in the running application: that Host process started before this version existed and had already cached `dsh-rea` as a host-only package, so neither the host-side channel nor the browser bundle can appear until it restarts. The bundle's behaviour is covered by the DOM harness, and the profile's `dsh-rea/client` resolution was verified directly (`dsh-rea/package.json` → this checkout, `dsh-rea/client` → `lib/client.js`).

The committed JSON reports are machine-readable verification evidence and include limitations rather than asserting universal equivalence.
