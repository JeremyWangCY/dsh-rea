// End-to-end host-side check of the prompt channel over real HTTP, using the
// exact installed DSH services: WebServer + Connection + the plugin's own RPC
// registration, including the browser cookie the real page carries. The
// browser bundle consumes this same wire, so this closes the gap between the
// in-process fake used by integration.mjs and the real Host.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as plugin from '../lib/index.js'

const DEFAULT_RUNTIME = 'C:\\Users\\Laptop\\AppData\\Roaming\\com.jeremy.deepx-workbench\\runtime'
const moduleRoot = process.env.DSH_REA_TEST_MODULE_ROOT ?? (existsSync(DEFAULT_RUNTIME) ? DEFAULT_RUNTIME : undefined)
const hostRequire = createRequire(moduleRoot ? pathToFileURL(`${moduleRoot.replace(/\\/g, '/').replace(/\/$/, '')}/noop.js`) : import.meta.url)
const load = async name => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const WebServer = (await load('@deepseek-ai/dsh-host-webserver')).default
const Connection = await load('@deepseek-ai/dsh-client-connection') // namespace plugin
const SystemPrompt = (await load('@deepseek-ai/dsh-system-prompt')).default
const Tools = (await load('@deepseek-ai/dsh-tools')).default
const Skills = (await load('@deepseek-ai/dsh-skill')).default

const checks = []
const pass = (name, details) => { checks.push({ name, pass: true, details }); console.log('PASS', name, details ? JSON.stringify(details) : '') }

/** In-memory credential provider: initializeSecret only calls modifyRecord. */
function credentialsStub() {
  const store = new Map()
  return {
    async modifyRecord(key, mutate) {
      const current = store.get(key)
      const next = await mutate(current)
      if (next === undefined) return current
      store.set(key, next)
      return next
    },
  }
}

/** Mint the browser session cookie exactly as the authenticated index route does. */
function mintCookie(connection, port) {
  const token = new URL(connection.authenticatedUrl(`http://127.0.0.1:${port}`)).searchParams.get('token')
  assert.ok(token, 'authenticatedUrl carries the process token')
  const captured = {}
  const response = {
    writeHead(status, headers) { captured.status = status; Object.assign(captured, headers); return this },
    setHeader(name, value) { captured[name.toLowerCase()] = value; return this },
    end() { return this },
  }
  connection.authorizeIndex({ url: `/?token=${token}`, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, response)
  assert.equal(captured.status, 303, `token exchange must redirect, got ${captured.status}`)
  const cookie = String(captured['set-cookie'] ?? '').split(';')[0]
  assert.match(cookie, /=/, 'token exchange must set a session cookie')
  return cookie
}

/** One real JSON-RPC round trip, exactly as createWebConnectionRpc sends it. */
async function rpc(port, method, payload, { cookie, rpcId = `probe-${method}`, host, headers, raw } = {}) {
  const requestHeaders = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(host ? { host } : {}), ...headers }
  for (const [name, value] of Object.entries(requestHeaders)) if (value === undefined) delete requestHeaders[name]
  const response = await fetch(`http://127.0.0.1:${port}/dsh-rea-prompts/${method}`, {
    method: 'POST',
    headers: requestHeaders,
    body: raw ?? JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const text = await response.text()
  return { status: response.status, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })() }
}

/** node:http probe for the cases fetch() cannot express (a forged Host header). */
function rawRequest(port, method, { cookie, host }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ type: 'client-request', rpcId: 'probe-host', method, payload: {} })
    const request = httpRequest({ host: '127.0.0.1', port, path: `/dsh-rea-prompts/${method}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), cookie, host } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })() })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

const paths = plugin.upstreamPaths()
const direct = new Client({ name: 'rea-reference', version: '1' }, { capabilities: {} })
const ctx = new Context()
try {
  await direct.connect(new StdioClientTransport({ command: process.execPath, args: [paths.launcher, 'mcp'], stderr: 'pipe' }))
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  ctx.provide('credentials', credentialsStub())
  // The production loader entry declares `inject: [webRuntime]`, which is what
  // puts `webServer` on the Connection plugin's own context; its `rpc` facade
  // registers routes through that same context. Mount it under an equivalent
  // inject scope so this scenario matches the real composition.
  await new Promise((resolve, reject) => {
    ctx.inject(['webServer'], (scoped) => { scoped.plugin(Connection, { trustedHosts: [] }).then(resolve, reject) })
  })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Skills, {})
  await ctx.plugin(Tools, { mode: 'native' })
  const fiber = await ctx.plugin(plugin, {})
  const deadline = Date.now() + 5000
  while (typeof ctx.webServer.port !== 'number' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  const port = ctx.webServer.port
  assert.equal(typeof port, 'number', 'WebServer did not listen')
  assert.equal(ctx.tools.schemas().filter(s => s.name.startsWith('mcp__rea__')).length, 170)
  pass('real Host: WebServer + Connection + dsh-rea mounted with 170 tools', { port, moduleRoot: moduleRoot ?? 'project checkout' })

  // Unauthenticated first: the fence must refuse before any handler runs.
  const anonymous = await rpc(port, 'list', {})
  assert.equal(anonymous.status, 401, `expected 401, got ${anonymous.status}: ${anonymous.text}`)
  pass('real HTTP: no browser session is 401 before dispatch')

  const cookie = mintCookie(ctx.connection, port)
  const valueOf = round => {
    assert.equal(round.status, 200, `HTTP ${round.status}: ${round.text}`)
    assert.ok(round.json, `response is not JSON: ${round.text}`)
    assert.equal(round.json.result.ok, true, JSON.stringify(round.json.result))
    return round.json.result.value
  }

  const list = valueOf(await rpc(port, 'list', {}, { cookie }))
  const reference = await direct.listPrompts()
  assert.deepEqual(list.prompts, reference.prompts)
  assert.equal(list.serverName, 'rea')
  assert.equal(typeof list.generation, 'number')
  pass('real HTTP: prompts/list equals a direct MCP client', { prompts: list.prompts.length })

  for (const prompt of reference.prompts) {
    const args = Object.fromEntries((prompt.arguments ?? []).filter(a => a.required).map(a => [a.name, 'verification']))
    assert.deepEqual(valueOf(await rpc(port, 'get', { name: prompt.name, arguments: args }, { cookie })), await direct.getPrompt({ name: prompt.name, arguments: args }))
  }
  pass('real HTTP: all six prompts/get render identically')

  const completion = { name: 'investigate_feature', argument: 'provider_id', value: '', arguments: {} }
  assert.deepEqual(valueOf(await rpc(port, 'complete', completion, { cookie })), await direct.complete({ ref: { type: 'ref/prompt', name: completion.name }, argument: { name: completion.argument, value: '' }, context: { arguments: {} } }))
  pass('real HTTP: completion/complete identical')

  const echoed = await rpc(port, 'list', {}, { cookie, rpcId: 'probe-correlation' })
  assert.equal(echoed.json.rpcId, 'probe-correlation', 'the caller correlation id must round-trip')

  const mismatched = await rpc(port, 'get', {}, { cookie, raw: JSON.stringify({ type: 'client-request', rpcId: 'probe-mismatch', method: 'list', payload: {} }) })
  assert.equal(mismatched.json.result.ok, false)
  assert.equal(mismatched.json.result.error.code, 'gateway/bad-request')
  pass('real HTTP: endpoint/method mismatch is a typed gateway error')

  const wrongType = await rpc(port, 'list', {}, { cookie, headers: { 'content-type': 'text/plain' } })
  assert.equal(wrongType.status, 415)
  pass('real HTTP: a non-JSON content type is refused before dispatch')

  const unknown = await rpc(port, 'nope', {}, { cookie })
  assert.equal(unknown.status, 200, 'the channel owns every endpoint under its prefix')
  assert.equal(unknown.json.result.ok, false)
  assert.equal(unknown.json.result.error.code, 'rea-prompt-error')
  pass('real HTTP: an unknown endpoint inside the channel is a typed error')

  // fetch() refuses to set a Host header, so this one probe speaks raw http.
  const untrusted = await rawRequest(port, 'list', { cookie, host: 'evil.example.test' })
  assert.equal(untrusted.status, 403)
  pass('real HTTP: an untrusted Host header is refused by the Connection fence')

  const noRpcId = await rpc(port, 'list', {}, { cookie, raw: JSON.stringify({ type: 'client-request', method: 'list', payload: {} }) })
  assert.equal(noRpcId.json.result.ok, false)
  assert.equal(noRpcId.json.result.error.code, 'gateway/bad-request')
  pass('real HTTP: an invalid envelope is rejected with a typed error')

  await fiber.dispose()
  const afterDispose = await rpc(port, 'list', {}, { cookie })
  assert.notEqual(afterDispose.json?.result?.ok, true, 'the channel must be gone after disposal')
  pass('real HTTP: plugin disposal removes the channel', { status: afterDispose.status })
} catch (error) {
  console.error(error)
  checks.push({ name: 'connection-scenario', pass: false, details: String(error?.message ?? error) })
  process.exitCode = 1
} finally {
  await direct.close().catch(() => {})
  await ctx.fiber.dispose().catch(() => {})
  console.log('REPORT', JSON.stringify({ checks, moduleRoot: moduleRoot ?? 'project checkout', failed: checks.filter(c => !c.pass).length }, null, 2))
}
