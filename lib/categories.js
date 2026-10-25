/**
 * Category model for the REA catalog.
 *
 * WHY CATEGORIES
 * The gate used to be all-or-nothing: an agent saw either no REA tool or every
 * one of them (~775 KB of model-side schema in native mode). Most sessions need
 * a small slice, so every upstream tool is assigned to exactly one category and
 * the gate (./gate.js) reveals categories per agent.
 *
 * HOW A TOOL GETS ITS CATEGORY
 * `categoryOf` maps the BASE name (without the `mcp__<server>__` prefix) through
 * exact-name OVERRIDES first, then the ordered RULES; the first match wins. A
 * name no rule maps lands in `other`, which is loadable like any category, so an
 * upstream release that adds tools never hides them. The coverage test fails on
 * such a release so the rules get extended deliberately.
 * @module dsh-rea/categories
 */

/** Every category id, in display order. `other` stays last. */
export const CATEGORY_IDS = Object.freeze([
  'native', 'android', 'apple', 'managed', 'web', 'wasm', 'dynamic',
  'providers', 'firmware', 'capture', 'reconstruction', 'other',
])

/** Pseudo-id meaning every category. */
export const ALL = 'all'

/** Model-facing one-line descriptions (each <= 80 characters). */
export const CATEGORIES = Object.freeze({
  native: { description: 'Native binaries: procedures, strings, xrefs, decompile, annotate, PE/ELF/Go/Rust' },
  android: { description: 'Android: APK/DEX packages and classes, resources, apktool, adb' },
  apple: { description: 'Apple: Objective-C/Swift metadata, Mach-O, plists, asset catalogs, archives' },
  managed: { description: 'Managed code: .NET/Java artifacts, members, native boundaries' },
  web: { description: 'Web/JS: pages, bundles, JavaScript runtime and sources, browser, Electron' },
  wasm: { description: 'WebAssembly artifacts and interfaces' },
  dynamic: { description: 'Dynamic analysis: instrumentation sessions, process capture, debugger sessions' },
  providers: { description: 'External tool front-ends: Cutter, rizin commands, JEB' },
  firmware: { description: 'Firmware images and regions, signatures, SQLite and other embedded artifacts' },
  capture: { description: 'Packet and signal recordings (REA supports these on Linux only)' },
  reconstruction: { description: 'Cross-platform: app graphs, feature tracing, comparison, reconstruction' },
  other: { description: 'Tools added upstream that no rule maps yet' },
})

/** Exact base-name overrides, checked before RULES. Keep this list short. */
const OVERRIDES = new Map([
  // Cross-artifact comparisons are reconstruction work, not web work.
  ['compare_bundles', 'reconstruction'],
])

/**
 * Ordered rules, most specific first. Each tests the base name.
 * @type {Array<{ category: string, test: (name: string) => boolean }>}
 */
const RULES = [
  // Cross-platform reconstruction families come first so e.g.
  // project_android_application_graph is not claimed by the android rule.
  { category: 'reconstruction', test: n => /application_graph|reconstruction|unknown|evidence_bundle|trace_application_feature|^trace_feature$|compare_application_versions|^compare_(artifacts|functions)$|^correlate_|find_changed_behavior|^build_call_path$/.test(n) },
  // Platform families.
  { category: 'android', test: n => /android|adb|apktool/.test(n) },
  { category: 'apple', test: n => /objc|swift|macho|plist|asset_catalog|keyed_archive|interface_builder|dylib|^list_architectures$/.test(n) },
  { category: 'managed', test: n => /managed/.test(n) },
  { category: 'wasm', test: n => /wasm/.test(n) },
  { category: 'web', test: n => /web|javascript|browser|electron|bundle/.test(n) },
  // Tool front-ends.
  { category: 'providers', test: n => /cutter|jeb|rizin/.test(n) && !/debug/.test(n) },
  // Dynamic analysis.
  { category: 'dynamic', test: n => /frida|gdb|_debug_|rizin_debug|process_(capture|scenario)|compare_process_captures|^observe_native_|^trace_native_|^capture_native_/.test(n) },
  // Packet / signal recordings.
  { category: 'capture', test: n => /packet|pcap|signal/.test(n) },
  // Firmware and embedded artifacts.
  { category: 'firmware', test: n => /firmware|signature|sqlite|evm|flutter|dart|recorded_crash/.test(n) },
  // The broad native family.
  { category: 'native', test: n => /native|binary|procedure|address|string|xref|bookmark|comment|decompile|segment|document|names?$|call_graph|callees|callers|bytes|instruction|objdump|pe_|go_|rust_|artifact|function|call_path|navigation|analysis_view|^current_|^goto_|^next_|^prev_|^set_/.test(n) },
]

/**
 * Category of one tool.
 * @param baseName - tool name WITHOUT the `mcp__<server>__` prefix.
 * @returns a category id; `other` when no rule maps the name.
 */
export function categoryOf(baseName) {
  const override = OVERRIDES.get(baseName)
  if (override !== undefined) return override
  for (const rule of RULES) if (rule.test(baseName)) return rule.category
  return 'other'
}

/**
 * Parse category names from a string or list.
 *
 * Case-insensitive; strings split on commas and whitespace; duplicates collapse;
 * `all` expands to every id.
 * @param input - one string or an array of strings.
 * @returns the recognised ids and the unrecognised tokens, in input order.
 */
export function normalizeCategories(input) {
  const tokens = (Array.isArray(input) ? input : [input])
    .flatMap(item => String(item ?? '').split(/[\s,]+/))
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length > 0)
  const valid = new Set()
  const unknown = []
  for (const token of tokens) {
    if (token === ALL) for (const id of CATEGORY_IDS) valid.add(id)
    else if (Object.hasOwn(CATEGORIES, token)) valid.add(token)
    else if (!unknown.includes(token)) unknown.push(token)
  }
  return { valid, unknown }
}

/**
 * One line per category for tool descriptions and status text.
 * @param exclude - ids to leave out, e.g. categories no one may load.
 * @returns the lines, in display order.
 */
export function describeCategories(exclude = []) {
  return CATEGORY_IDS.filter(id => !exclude.includes(id)).map(id => `- ${id}: ${CATEGORIES[id].description}`)
}
