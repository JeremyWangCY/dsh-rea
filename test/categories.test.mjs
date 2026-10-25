import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  ALL, CATEGORIES, CATEGORY_IDS, categoryOf, describeCategories, normalizeCategories,
} from '../lib/categories.js'

const require = createRequire(import.meta.url)

test('every category id has a description of at most 80 characters', () => {
  assert.deepEqual(Object.keys(CATEGORIES).sort(), [...CATEGORY_IDS].sort())
  for (const id of CATEGORY_IDS) {
    const text = CATEGORIES[id].description
    assert.ok(text.length > 0 && text.length <= 80, `${id}: ${text.length} chars`)
  }
  assert.equal(CATEGORY_IDS.at(-1), 'other')
})

test('categoryOf maps representative names per category', () => {
  const expected = {
    native: ['open_binary', 'procedure_pseudo_code', 'xrefs', 'list_strings', 'inspect_go_binary', 'set_comment'],
    android: ['inspect_android_package', 'list_adb_devices', 'inspect_apktool_client'],
    apple: ['get_objc_classes', 'inspect_macho', 'inspect_plist', 'demangle_swift'],
    managed: ['inspect_managed_artifact', 'compare_managed_members'],
    web: ['inspect_web_page', 'analyze_web_bundle', 'list_electron_targets', 'recover_javascript_sources', 'compare_source_to_bundle'],
    wasm: ['inspect_wasm_artifact', 'compare_wasm_interfaces'],
    dynamic: ['start_frida_session', 'gdb_console', 'rizin_debug_command', 'capture_process_scenario', 'observe_native_calls'],
    providers: ['cutter_command', 'open_jeb_project', 'execute_rizin_command'],
    firmware: ['inspect_firmware_regions', 'inspect_sqlite_database', 'inspect_dart_aot'],
    capture: ['inspect_packet_capture', 'decode_signal_recording', 'inspect_pcap_capture'],
    reconstruction: ['project_android_application_graph', 'trace_application_feature', 'list_unknowns', 'export_evidence_bundle', 'compare_bundles'],
  }
  for (const [category, names] of Object.entries(expected)) {
    for (const name of names) assert.equal(categoryOf(name), category, name)
  }
})

test('categoryOf falls back to other for names no rule maps', () => {
  assert.equal(categoryOf('zzz_brand_new_tool'), 'other')
})

test('normalizeCategories handles case, separators, duplicates and all', () => {
  assert.deepEqual([...normalizeCategories('Native, ANDROID web').valid], ['native', 'android', 'web'])
  assert.deepEqual([...normalizeCategories(['native', 'native,wasm']).valid], ['native', 'wasm'])
  assert.deepEqual([...normalizeCategories(ALL).valid], [...CATEGORY_IDS])
  assert.equal(normalizeCategories(['native', 'all']).valid.size, CATEGORY_IDS.length)
  const { valid, unknown } = normalizeCategories('native foo,Bar foo')
  assert.deepEqual([...valid], ['native'])
  assert.deepEqual(unknown, ['foo', 'bar'])
  assert.equal(normalizeCategories('').valid.size, 0)
})

test('describeCategories emits one line per id', () => {
  const lines = describeCategories()
  assert.equal(lines.length, CATEGORY_IDS.length)
  assert.ok(lines[0].startsWith('- native: '))
})

test('every tool in the installed REA maps to a category other than other', { timeout: 60000 }, async () => {
  const launcher = require.resolve('rea-agents/package.json').replace(/package\.json$/, 'scripts/rea.mjs')
  const client = new Client({ name: 'dsh-rea-category-coverage', version: '1' }, { capabilities: {} })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher, 'mcp'], stderr: 'pipe' }))
    const names = []
    let cursor
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      names.push(...page.tools.map(tool => tool.name))
      cursor = page.nextCursor
    } while (cursor)
    assert.ok(names.length > 0)
    const unmapped = names.filter(name => categoryOf(name) === 'other')
    assert.deepEqual(unmapped, [], 'extend RULES in lib/categories.js for: ' + unmapped.join(', '))
  } finally {
    await client.close()
  }
})
