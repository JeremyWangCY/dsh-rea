# Differential verification of dsh-rea 0.2.0

## Conclusion

The plugin launches the **unchanged pinned `rea-agents@6.4.0` MCP executable** and mounts its complete tool catalog through DSH's official MCP bridge. It does not rewrite analysis algorithms or substitute CLI calls. The verified tool input contracts and deterministic result envelopes match the upstream server. This is **bounded adapter parity, not a claim that every engine and LLM answer is equivalent**.

## Reproduce

Use Node `^22.19.0 || ^24.11.0 || >=26.0.0`:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm verify
node verify/measure.mjs
```

`DSH_REA_TEST_MODULE_ROOT` optionally selects an installed DSH module root for Cordis/system-prompt/tools/skills/worker services; otherwise checkout dependencies are used. Both clients run the same installed upstream package. Fixtures are regenerated deterministically by the test. Evidence identities include absolute source paths, so IDs on another machine may differ; each run compares both sides on that machine.

## Method and results

- Real SDK reference client → upstream stdio MCP.
- Real Cordis host → dsh-rea → official DSH MCP bridge → separate upstream stdio MCP.
- Second pass through the real DSH worker-thread `run_code` interface.
- Complete `content` and `structuredContent` deep comparison, not selected fields or mocks.
- **31 checks passed** in the checked-in integration report; **5 unit tests passed**.
- All **170 names, descriptions and input schemas** compared.
- Original Skill v37 body, metadata, resource directory and six references checked.
- JS fixture includes fetch/header, child-process, event, closure and timer syntax. Analysis and retained data-flow trace compared.
- Retained Evidence view and bundle listing compared; reference producer is rerun per mode because closing an upstream target clears retained evidence.
- Offline HAR contains one HTTP transaction, and ZIP contains one text member. No fixture application code or recorded URL is executed/fetched.
- Missing-file upstream error, pre-dispatch cancellation, post-cancellation liveness, scoped tool disposal and missing-launcher startup failure tested.
- Six upstream MCP prompts rendered independently; their presence is not claimed to create a DSH prompt UI.

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
3. The official bridge preserves result payloads, but does not copy MCP annotations into ToolRuntime metadata. Upstream prompts/completions have no DSH UI integration. An execution mode requiring MCP tasks would not be callable through this bridge.
4. Official DSH subprocess launch scrubs inherited credential-shaped/DSH variables. Explicit REA environment values are forwarded; users must explicitly configure relevant provider variables. Codex process inheritance is not assumed identical.
5. PTC surfaces errors as `ToolCallError` rather than raw MCP `isError`; the tested upstream message remains available.
6. Model inference quality, provider schema acceptance limits and full client/UI equivalence are **not** proven by transport comparison.
7. The published peer range includes DSH 0.2.0-rc.2 because this desktop runtime activated the adapter, but the isolated differential suite's checked-in dependencies target the tested 0.1.5-rc.3 services. Version-specific integration should be rerun on a new Host.

The committed JSON reports are machine-readable verification evidence and include limitations rather than asserting universal equivalence.
