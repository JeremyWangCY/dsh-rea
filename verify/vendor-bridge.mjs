// Reproducible copy of the MIT official bridge. No tool algorithm is changed;
// the only local edit exposes the live Client to the prompt facade.
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const EXPECTED_VERSION = '0.1.5-rc.3'

/** The reviewed local patch, as exact source substitutions. */
const CHANGES = [
  ['function startConnection(ctx, config, policy) {', 'function startConnection(ctx, config, policy, onClient) {'],
  ['\t\tclient = void 0;\n\t\tclientClosed = void 0;\n\t\tscheduleReconnect();', '\t\tclient = void 0;\n\t\tclientClosed = void 0;\n\t\tonClient?.(undefined);\n\t\tscheduleReconnect();'],
  ['\t\t\tawait enqueueSync(generation, startup ? startupOpts : opts);', '\t\t\tawait enqueueSync(generation, startup ? startupOpts : opts);\n\t\t\tif (isCurrent(generation) && !hasClosed()) onClient?.(generation);'],
  ['\t\t\tdisposed = true;', '\t\t\tdisposed = true;\n\t\t\tonClient?.(undefined);'],
  ['async function apply(ctx, config) {', 'async function apply(ctx, config, onClient) {'],
  ['startConnection(ctx, config, reconnect);', 'startConnection(ctx, config, reconnect, onClient);'],
]

/**
 * Render the vendored bridge from the installed upstream package.
 * @returns upstream identity, digests, and the exact file text.
 */
export async function renderVendoredBridge() {
  const root = dirname(require.resolve('@deepseek-ai/dsh-mcp-client/package.json'))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (pkg.version !== EXPECTED_VERSION) throw Error(`Review the upstream bridge before updating the vendor: expected ${EXPECTED_VERSION}, found ${pkg.version}`)
  const source = await readFile(join(root, 'lib/index.js'), 'utf8')
  let modified = source
  for (const [before, after] of CHANGES) {
    if (modified.split(before).length !== 2) throw Error(`Patch anchor ambiguous or missing: ${JSON.stringify(before)}`)
    modified = modified.replace(before, after)
  }
  const sha = createHash('sha256').update(source).digest('hex')
  const code = `// Vendored from @deepseek-ai/dsh-mcp-client ${pkg.version} (MIT).
//
// MIT License
//
// Copyright (c) 2026 DeepSeek
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Upstream source SHA256 ${sha}
// Local change: an optional fourth \`onClient\` argument exposes the live MCP
// Client so the prompt/completions facade shares this exact connection and
// process. No tool registration, transport, reconnect or error behavior is
// altered. Regenerate with \`node verify/vendor-bridge.mjs\`.
${modified}`
  return { version: pkg.version, upstreamSha256: sha, patches: CHANGES.length, code }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { version, upstreamSha256, patches, code } = await renderVendoredBridge()
  await mkdir(new URL('../lib/vendor/', import.meta.url), { recursive: true })
  await writeFile(new URL('../lib/vendor/mcp-bridge.js', import.meta.url), code)
  console.log(JSON.stringify({ version, upstreamSha256, patches }))
}
