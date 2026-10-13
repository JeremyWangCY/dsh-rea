// Loads the real browser bundle with a minimal React/DOM harness, so the
// prompts/completions panel is exercised end to end without a live GUI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Minimal hook runtime: one store per component function, effects after render. */
function createReact() {
  const stores = new WeakMap()
  let dirty = false
  const current = []
  const useState = (init) => {
    const store = current.at(-1)
    const index = store.cursor++
    if (!(index in store.states)) store.states[index] = typeof init === 'function' ? init() : init
    return [store.states[index], (update) => {
      const next = typeof update === 'function' ? update(store.states[index]) : update
      if (!Object.is(next, store.states[index])) { store.states[index] = next; dirty = true }
    }]
  }
  const useEffect = (effect, deps) => {
    const store = current.at(-1)
    const index = store.cursor++
    const previous = store.effects[index]
    const changed = previous === undefined || deps === undefined || previous.deps === undefined
      || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (changed) {
      previous?.cleanup?.()
      store.effects[index] = { deps, cleanup: effect() }
    }
  }
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length > 1 ? children : children[0] } }), Fragment: Symbol('Fragment'), useState, useEffect }
  const render = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return { type: 'text', props: { children: String(element) } }
    if (Array.isArray(element)) return element.map(render)
    const { type, props } = element
    if (type === react.Fragment) return render(props.children)
    if (typeof type !== 'function') return { type, props, children: render(props.children) }
    let store = stores.get(type)
    if (store === undefined) { store = { states: [], effects: [], cursor: 0 }; stores.set(type, store) }
    store.cursor = 0
    current.push(store)
    try { return render(type(props)) } finally { current.pop() }
  }
  const flush = () => { render.root(); return dirty }
  return { react, render, isDirty: () => dirty, clearDirty: () => { dirty = false } }
}

/** Depth-first search of the rendered tree. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found }
  if (predicate(node)) found.push(node)
  findAll(node.children, predicate, found)
  return found
}
const byText = (node, text) => findAll(node, n => n.type === 'button' && n.props.children === text)[0]
const byLabel = (node, label) => findAll(node, n => n.props?.['aria-label'] === label)[0]

/** One harness: fake DOM, captured bundle factory, fake services and RPC. */
async function mount(options = {}) {
  const calls = []
  let registration
  let injected
  const effects = []
  const rpc = {
    async call(channel, method, args) {
      calls.push({ channel, method, args })
      const script = options.responses?.[method]
      if (script) return script(args)
      throw new Error(`unexpected rpc ${method}`)
    },
  }
  const slots = {
    inject(key, callback) { injected = key; return callback() },
    register(spec, component) { registration = { spec, component }; return () => {} },
  }
  const context = {
    effect(callback) { effects.push(callback()); return () => {} },
    get: (key) => (key === 'slots' ? slots : key === 'connection' ? { rpc } : undefined),
  }
  let factory
  let bundle
  globalThis.window = { __ModuleLoader__: { load: (handoff) => { factory = handoff } } }
  const styleNode = { dataset: {}, style: {}, textContent: '', remove() {} }
  globalThis.document = { createElement: () => styleNode, head: { append() {} } }
  try {
    await import(`../lib/client.js?cacheBust=${Math.random()}`)
    assert.equal(factory.id, 'dsh-rea')
    bundle = factory.factory((specifier) => {
      assert.equal(specifier, 'react')
      return harness.react
    })
    bundle.apply(context)
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
  return { module: bundle, calls, registration, injected, effects, rpc }
}

/** Named harness so the factory's require can reach it. */
let harness
function fresh() {
  harness = createReact()
  return harness
}

const PROMPTS = [
  {
    name: 'investigate_feature',
    title: 'Investigate a feature',
    description: 'Trace a feature through evidence.',
    arguments: [
      { name: 'feature', description: 'Feature to investigate', required: true },
      { name: 'provider', description: 'Provider identity', required: false },
    ],
  },
  { name: 'trace_crash', title: 'Trace a crash', description: 'Trace a recorded crash.', arguments: [{ name: 'crash', description: 'Crash path', required: true }] },
]
const listReply = { ok: true, value: { prompts: PROMPTS, generation: 1, serverName: 'rea' } }

test('bundle registers one session-scoped composer entry and its own styles', async () => {
  const react = fresh()
  const mounted = await mount()
  assert.deepEqual(mounted.module.inject, ['slots', 'connection'])
  assert.equal(mounted.injected, 'conversation.input.left')
  assert.deepEqual(mounted.registration.spec, { name: 'conversation.input.left', id: 'dsh-rea-prompts', order: 50 })
  assert.equal(typeof mounted.registration.component, 'function')
  assert.equal(mounted.effects.length, 1, 'one style effect')
})

test('panel lists original prompts, completes arguments and inserts the exact preview', async () => {
  const react = fresh()
  const mounted = await mount({
    responses: {
      list: () => listReply,
      complete: () => ({ ok: true, value: { completion: { values: ['auto', 'hopper', 'ghidra'] } } }),
      get: ({ name, arguments: args }) => {
        assert.deepEqual(args, { feature: 'login', provider: 'hopper' })
        return { ok: true, value: { description: 'Rendered', messages: [{ role: 'user', content: { type: 'text', text: `# ${name}\nfeature=login` } }] } }
      },
    },
  })
  const { component } = mounted.registration
  const draft = 'existing draft'
  const setDraft = []
  const props = {
    sessionId: 's1',
    rpc: mounted.rpc,
    useInput: (selector) => selector({ draft }),
    inputActions: { setDraft: (text) => { setDraft.push(text) } },
  }
  let tree = react.render(react.react.createElement(component, props))
  // Closed panel: no protocol traffic before the user opens it.
  assert.deepEqual(mounted.calls, [])
  assert.ok(byText(tree, 'REA 模板'), 'compact launch control')
  byText(tree, 'REA 模板').props.onClick()
  for (let i = 0; i < 5; i++) { react.render(react.react.createElement(component, props)); await new Promise(r => setTimeout(r, 0)) }
  tree = react.render(react.react.createElement(component, props))
  assert.deepEqual(mounted.calls.map(c => [c.method, c.args]), [['list', {}]])
  assert.ok(byLabel(tree, 'feature'), 'required argument input rendered')
  assert.ok(byLabel(tree, 'provider'), 'optional argument input rendered')
  // Dynamic completion is requested for the focused argument only.
  byLabel(tree, 'provider').props.onFocus()
  react.render(react.react.createElement(component, props))
  await new Promise(r => setTimeout(r, 300))
  for (let i = 0; i < 5; i++) { react.render(react.react.createElement(component, props)); await new Promise(r => setTimeout(r, 10)) }
  tree = react.render(react.react.createElement(component, props))
  const complete = mounted.calls.find(c => c.method === 'complete')
  assert.deepEqual(complete.args, { name: 'investigate_feature', argument: 'provider', value: '', arguments: {} })
  const suggestion = byText(tree, 'hopper')
  assert.ok(suggestion, 'completion values offered')
  suggestion.props.onClick()
  react.render(react.react.createElement(component, props))
  tree = react.render(react.react.createElement(component, props))
  assert.equal(byLabel(tree, 'provider').props.value, 'hopper', 'accepted completion fills the argument')
  byLabel(tree, 'feature').props.onChange({ target: { value: 'login' } })
  react.render(react.react.createElement(component, props))
  tree = react.render(react.react.createElement(component, props))
  // Insertion stays disabled until an exact preview exists.
  assert.equal(byText(tree, '插入输入框（不发送）').props.disabled, true)
  byText(tree, '生成预览').props.onClick()
  for (let i = 0; i < 5; i++) { react.render(react.react.createElement(component, props)); await new Promise(r => setTimeout(r, 0)) }
  tree = react.render(react.react.createElement(component, props))
  assert.deepEqual(mounted.calls.find(c => c.method === 'get').args, { name: 'investigate_feature', arguments: { provider: 'hopper', feature: 'login' } })
  assert.equal(byLabel(tree, '原版文本预览').props.value, '# investigate_feature\nfeature=login', 'preview is the original rendered text')
  byText(tree, '插入输入框（不发送）').props.onClick()
  assert.deepEqual(setDraft, ['existing draft\n\n# investigate_feature\nfeature=login'], 'insertion preserves the draft and never submits')
  assert.deepEqual(Object.keys(props.inputActions), ['setDraft'], 'the panel cannot submit: it receives only setDraft')
})

test('required arguments gate the preview request', async () => {
  const react = fresh()
  const mounted = await mount({ responses: { list: () => listReply } })
  const { component } = mounted.registration
  const props = { sessionId: 's1', rpc: mounted.rpc, useInput: (selector) => selector({ draft: '' }), inputActions: { setDraft() {} } }
  react.render(react.react.createElement(component, props))
  byText(react.render(react.react.createElement(component, props)), 'REA 模板').props.onClick()
  for (let i = 0; i < 5; i++) { react.render(react.react.createElement(component, props)); await new Promise(r => setTimeout(r, 0)) }
  const tree = react.render(react.react.createElement(component, props))
  assert.equal(byText(tree, '生成预览').props.disabled, true, 'empty required argument blocks preview')
  assert.equal(mounted.calls.some(c => c.method === 'get'), false)
})

test('failed protocol calls surface an alert and no preview', async () => {
  const react = fresh()
  const mounted = await mount({ responses: { list: () => ({ ok: false, error: { code: 'rea-prompt-error', message: 'REA connection unavailable' } }) } })
  const { component } = mounted.registration
  const props = { sessionId: 's1', rpc: mounted.rpc, useInput: (selector) => selector({ draft: '' }), inputActions: { setDraft() {} } }
  react.render(react.react.createElement(component, props))
  byText(react.render(react.react.createElement(component, props)), 'REA 模板').props.onClick()
  for (let i = 0; i < 5; i++) { react.render(react.react.createElement(component, props)); await new Promise(r => setTimeout(r, 0)) }
  const tree = react.render(react.react.createElement(component, props))
  assert.equal(findAll(tree, n => n.props?.role === 'alert')[0].props.children, 'REA connection unavailable')
  assert.equal(byLabel(tree, '原版文本预览'), undefined)
})

test('a missing channel names the restart remedy instead of a bare transport status', async () => {
  const react = fresh()
  const mounted = await mount({ responses: { list: () => { throw new Error('transport failure for /dsh-rea-prompts/list: HTTP 404') } } })
  const { component } = mounted.registration
  const props = { sessionId: 's1', rpc: mounted.rpc, useInput: (selector) => selector({ draft: '' }), inputActions: { setDraft() {} } }
  react.render(react.react.createElement(component, props))
  byText(react.render(react.react.createElement(component, props)), 'REA 模板').props.onClick()
  for (let i = 0; i < 5; i++) { react.render(react.react.createElement(component, props)); await new Promise(r => setTimeout(r, 0)) }
  const alert = findAll(react.render(react.react.createElement(component, props)), n => n.props?.role === 'alert')[0]
  assert.match(alert.props.children, /重启一次 DSH/)
  assert.match(alert.props.children, /HTTP 404/)
})
