// End-to-end host-side check of the prompt endpoint over real HTTP, using the
// exact installed DSH services: WebServer + Connection + the plugin's own
// route, mounted the way the production loader composes them (the Connection
// plugin's context does NOT carry webServer — a registration path that needs it
// fails here too, which is how an earlier revision broke activation).
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
// The browser caller's own response validator: its acceptance is the real bar.
const { serverResponseSchema } = Connection
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

/** One real round trip over node:http, so a forged Host header is expressible. */
function call(port, endpoint, { cookie, host, method = 'POST', contentType = 'application/json', body, rpcId = `probe-${endpoint}` } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ?? JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: {} })
    const headers = { 'content-type': contentType }
    if (method !== 'GET') headers['content-length'] = Buffer.byteLength(payload)
    if (cookie !== undefined) headers.cookie = cookie
    if (host !== undefined) headers.host = host
    const request = httpRequest({ host: '127.0.0.1', port, path: `/dsh-rea-prompts/${endpoint}`, method, headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })(), rpcId })
      })
    })
    request.on('error', reject)
    request.end(method === 'GET' ? undefined : payload)
  })
}

const paths = plugin.upstreamPaths()
const direct = new Client({ name: 'rea-reference', version: '1' }, { capabilities: {} })
const ctx = new Context()
try {
  await direct.connect(new StdioClientTransport({ command: process.execPath, args: [paths.launcher, 'mcp'], stderr: 'pipe' }))
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  ctx.provide('credentials', credentialsStub())
  // Production composition: the loader entry injects [webRuntime], so the
  // Connection plugin's own context has no webServer. Mounting it that way is
  // what makes this scenario catch a registration path that needs one.
  await ctx.plugin(Connection, { trustedHosts: [] })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Skills, {})
  await ctx.plugin(Tools, { mode: 'native' })
  const fiber = await ctx.plugin(plugin, {})
  const deadline = Date.now() + 5000
  while (typeof ctx.webServer.port !== 'number' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  const port = ctx.webServer.port
  assert.equal(typeof port, 'number', 'WebServer did not listen')
  const reaToolCount = ctx.tools.schemas().filter(s => s.name.startsWith('mcp__rea__')).length
  assert.ok(reaToolCount > 0, 'the bridge registered no mcp__rea__ tools')
  pass(`real Host: WebServer + production-shaped Connection + dsh-rea, ${reaToolCount} tools`, { port, moduleRoot: moduleRoot ?? 'project checkout' })

  // Unauthenticated first: the fence must refuse before any handler runs.
  const anonymous = await call(port, 'list')
  assert.equal(anonymous.status, 401, `expected 401, got ${anonymous.status}: ${anonymous.text}`)
  pass('real HTTP: no browser session is 401 before dispatch')

  const cookie = mintCookie(ctx.connection, port)
  const valueOf = round => {
    assert.equal(round.status, 200, `HTTP ${round.status}: ${round.text}`)
    const parsed = serverResponseSchema.parse(round.json)
    assert.equal(parsed.rpcId, round.rpcId, 'the caller correlation id must round-trip')
    assert.equal(parsed.result.ok, true, JSON.stringify(parsed.result))
    return parsed.result.value
  }

  const list = valueOf(await call(port, 'list', { cookie }))
  const reference = await direct.listPrompts()
  assert.deepEqual(list.prompts, reference.prompts)
  assert.equal(list.serverName, 'rea')
  assert.equal(typeof list.generation, 'number')
  pass('real HTTP: prompts/list equals a direct MCP client', { prompts: list.prompts.length })

  for (const prompt of reference.prompts) {
    const args = Object.fromEntries((prompt.arguments ?? []).filter(a => a.required).map(a => [a.name, 'verification']))
    const body = JSON.stringify({ type: 'client-request', rpcId: `get-${prompt.name}`, method: 'get', payload: { name: prompt.name, arguments: args } })
    assert.deepEqual(valueOf(await call(port, 'get', { cookie, body, rpcId: `get-${prompt.name}` })), await direct.getPrompt({ name: prompt.name, arguments: args }))
  }
  pass('real HTTP: all six prompts/get render identically')

  const completion = { name: 'investigate_feature', argument: 'provider_id', value: '', arguments: {} }
  const completionBody = JSON.stringify({ type: 'client-request', rpcId: 'complete-1', method: 'complete', payload: completion })
  assert.deepEqual(
    valueOf(await call(port, 'complete', { cookie, body: completionBody, rpcId: 'complete-1' })),
    await direct.complete({ ref: { type: 'ref/prompt', name: completion.name }, argument: { name: completion.argument, value: '' }, context: { arguments: {} } }),
  )
  pass('real HTTP: completion/complete identical')

  const mismatch = await call(port, 'get', { cookie, body: JSON.stringify({ type: 'client-request', rpcId: 'mismatch', method: 'list', payload: {} }), rpcId: 'mismatch' })
  assert.equal(serverResponseSchema.parse(mismatch.json).result.error.code, 'gateway/bad-request')
  pass('real HTTP: endpoint/method mismatch is a typed gateway error')

  const badEnvelope = await call(port, 'list', { cookie, body: JSON.stringify({ type: 'client-request', method: 'list', payload: {} }) })
  const badEnvelopeParsed = serverResponseSchema.parse(badEnvelope.json)
  assert.equal(badEnvelopeParsed.rpcId, 'invalid-request')
  assert.equal(badEnvelopeParsed.result.error.code, 'gateway/bad-request')
  pass('real HTTP: an envelope without rpcId is a typed error, not a crash')

  const wrongType = await call(port, 'list', { cookie, contentType: 'text/plain' })
  assert.equal(wrongType.status, 415)
  pass('real HTTP: a non-JSON content type is refused before dispatch')

  const notJson = await call(port, 'list', { cookie, body: 'not json' })
  assert.equal(notJson.status, 400)
  const wrongMethod = await call(port, 'list', { cookie, method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  pass('real HTTP: malformed body and a non-POST method are refused', { notJson: notJson.status, wrongMethod: wrongMethod.status })

  const unknown = await call(port, 'nope', { cookie })
  assert.equal(unknown.status, 404)
  pass('real HTTP: an unknown endpoint is 404, never a prompt call')

  const untrusted = await call(port, 'list', { cookie, host: 'evil.example.test' })
  assert.equal(untrusted.status, 403)
  pass('real HTTP: an untrusted Host header is refused by the Connection fence')

  await fiber.dispose()
  const afterDispose = await call(port, 'list', { cookie })
  assert.notEqual(afterDispose.status, 200, 'the route must be gone after disposal')
  pass('real HTTP: plugin disposal removes the route', { status: afterDispose.status })
} catch (error) {
  console.error(error)
  checks.push({ name: 'connection-scenario', pass: false, details: String(error?.message ?? error) })
  process.exitCode = 1
} finally {
  await direct.close().catch(() => {})
  await ctx.fiber.dispose().catch(() => {})
  console.log('REPORT', JSON.stringify({ checks, moduleRoot: moduleRoot ?? 'project checkout', failed: checks.filter(c => !c.pass).length }, null, 2))
}
