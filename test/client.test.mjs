// Loads the real browser bundle with a minimal React/DOM harness, so the
// '/' prompt source and its argument form are exercised end to end without a
// live GUI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sourceText = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

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
const alertText = node => findAll(node, n => n.props?.role === 'alert')[0]?.props.children

/** Settle effects and pending promises: render, tick, repeat. */
async function settle(react, renderTree, times = 5, delay = 0) {
  let tree = null
  for (let i = 0; i < times; i++) { tree = renderTree(); await new Promise(r => setTimeout(r, delay)) }
  return tree
}

/** One harness: fake DOM, captured bundle factory, fake services and RPC. */
async function mount(options = {}) {
  const calls = []
  let slotRegistration
  let sourceRegistration
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
    register(spec, component) { slotRegistration = { spec, component }; return () => {} },
  }
  const inputTriggers = { registerSource(source) { sourceRegistration = source; return () => {} } }
  const context = {
    effect(callback) { effects.push(callback()); return () => {} },
    get: (key) => (key === 'slots' ? slots : key === 'connection' ? { rpc } : key === 'inputTriggers' ? inputTriggers : undefined),
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
  return { module: bundle, calls, slotRegistration, sourceRegistration, injected, effects, rpc }
}

/** Named harness so the factory's require can reach it. */
let harness
function fresh() {
  harness = createReact()
  return harness
}

const session = { sessionId: 's1' }
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
const props = () => ({ sessionId: 's1', useInput: (selector) => selector({ draft: 'existing draft' }), inputActions: { setDraft() {} } })

test('bundle registers a session slot and a / source, and shows nothing until picked', async () => {
  fresh()
  const mounted = await mount()
  assert.deepEqual(mounted.module.inject, ['slots', 'connection', 'inputTriggers'])
  assert.equal(mounted.injected, 'conversation.input.left')
  assert.deepEqual(mounted.slotRegistration.spec, { name: 'conversation.input.left', id: 'dsh-rea-prompts', order: 50 })
  assert.deepEqual(
    { trigger: mounted.sourceRegistration.trigger, name: mounted.sourceRegistration.name, order: mounted.sourceRegistration.order },
    { trigger: '/', name: 'rea', order: 3 },
  )
  assert.equal(mounted.effects.length, 2, 'one style effect and one source effect')
  assert.deepEqual(mounted.calls, [], 'no protocol traffic before the menu opens')
  // Closed form contributes no control at all: no box, no button.
  const tree = harness.render(harness.react.createElement(mounted.slotRegistration.component, props()))
  assert.equal(tree, null, 'the session slot renders nothing while idle')
})

test('the / source filters the original names and picking only opens the form', async () => {
  fresh()
  const mounted = await mount({ responses: { list: () => listReply } })
  const candidates = await mounted.sourceRegistration.candidates(session, { query: 'inv', position: 'leading', signal: new AbortController().signal })
  assert.deepEqual(candidates, [{ name: 'rea:investigate_feature', description: 'Trace a feature through evidence.' }])
  const aborted = new AbortController(); aborted.abort()
  assert.deepEqual(await mounted.sourceRegistration.candidates(session, { query: 'inv', position: 'leading', signal: aborted.signal }), [], 'a superseded keystroke yields no candidates')
  const outcome = mounted.sourceRegistration.onPick({ candidate: { name: 'rea:investigate_feature' }, session, position: 'leading', via: 'menu', span: {} })
  assert.equal(outcome, 'handled', 'the pick must not insert text into the draft')
  await settle(harness, () => harness.render(harness.react.createElement(mounted.slotRegistration.component, props())))
  assert.deepEqual(mounted.calls.map(c => c.method), ['list'], 'the catalog is fetched once and shared with the form')
})

test('picked template fills arguments, previews the original text and inserts on request only', async () => {
  fresh()
  const setDraft = []
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
  const component = mounted.slotRegistration.component
  const componentProps = { ...props(), inputActions: { setDraft: text => { setDraft.push(text) } } }
  const renderTree = () => harness.render(harness.react.createElement(component, componentProps))
  assert.equal(renderTree(), null)
  mounted.sourceRegistration.onPick({ candidate: { name: 'rea:investigate_feature' }, session, position: 'leading', via: 'menu', span: {} })
  let tree = await settle(harness, renderTree)
  assert.equal(byText(tree, 'REA 模板'), undefined, 'no launch button exists')
  assert.ok(byLabel(tree, 'feature'), 'required argument input rendered')
  assert.ok(byLabel(tree, 'provider'), 'optional argument input rendered')
  assert.deepEqual(setDraft, [], 'opening the form writes nothing')
  byLabel(tree, 'provider').props.onFocus()
  renderTree()
  await new Promise(r => setTimeout(r, 300))
  tree = await settle(harness, renderTree, 5, 10)
  assert.deepEqual(mounted.calls.find(c => c.method === 'complete').args, { name: 'investigate_feature', argument: 'provider', value: '', arguments: {} })
  byText(tree, 'hopper').props.onClick()
  tree = await settle(harness, renderTree)
  assert.equal(byLabel(tree, 'provider').props.value, 'hopper', 'accepted completion fills the argument')
  byLabel(tree, 'feature').props.onChange({ target: { value: 'login' } })
  tree = await settle(harness, renderTree)
  assert.equal(byText(tree, '插入输入框（不发送）').props.disabled, true, 'insertion needs an exact preview')
  byText(tree, '生成预览').props.onClick()
  tree = await settle(harness, renderTree)
  assert.deepEqual(mounted.calls.find(c => c.method === 'get').args, { name: 'investigate_feature', arguments: { provider: 'hopper', feature: 'login' } })
  assert.equal(byLabel(tree, '原版文本预览').props.value, '# investigate_feature\nfeature=login', 'preview is the original rendered text')
  byText(tree, '插入输入框（不发送）').props.onClick()
  assert.deepEqual(setDraft, ['existing draft\n\n# investigate_feature\nfeature=login'], 'insertion preserves the draft and never submits')
  assert.deepEqual(Object.keys(componentProps.inputActions), ['setDraft'], 'the form cannot submit: it receives only setDraft')
  assert.equal(renderTree(), null, 'insertion closes the form')
})

test('required arguments gate the preview request', async () => {
  fresh()
  const mounted = await mount({ responses: { list: () => listReply } })
  const component = mounted.slotRegistration.component
  const componentProps = props()
  const renderTree = () => harness.render(harness.react.createElement(component, componentProps))
  mounted.sourceRegistration.onPick({ candidate: { name: 'rea:trace_crash' }, session, position: 'leading', via: 'menu', span: {} })
  const tree = await settle(harness, renderTree)
  assert.equal(byText(tree, '生成预览').props.disabled, true, 'empty required argument blocks preview')
  byLabel(tree, 'crash').props.onChange({ target: { value: 'sigsegv' } })
  const after = await settle(harness, renderTree)
  assert.equal(byText(after, '生成预览').props.disabled, false)
  assert.equal(mounted.calls.some(c => c.method === 'get'), false)
})

test('failed protocol calls surface an alert and no preview', async () => {
  fresh()
  const mounted = await mount({ responses: { list: () => ({ ok: false, error: { code: 'rea-prompt-error', message: 'REA connection unavailable' } }) } })
  const component = mounted.slotRegistration.component
  const componentProps = props()
  mounted.sourceRegistration.onPick({ candidate: { name: 'rea:investigate_feature' }, session, position: 'leading', via: 'menu', span: {} })
  const tree = await settle(harness, () => harness.render(harness.react.createElement(component, componentProps)))
  assert.equal(alertText(tree), 'REA connection unavailable')
  assert.equal(byLabel(tree, '原版文本预览'), undefined)
})

test('a missing channel names the restart remedy instead of a bare transport status', async () => {
  fresh()
  const mounted = await mount({ responses: { list: () => { throw new Error('transport failure for /dsh-rea-prompts/list: HTTP 404') } } })
  const component = mounted.slotRegistration.component
  const componentProps = props()
  mounted.sourceRegistration.onPick({ candidate: { name: 'rea:investigate_feature' }, session, position: 'leading', via: 'menu', span: {} })
  const tree = await settle(harness, () => harness.render(harness.react.createElement(component, componentProps)))
  assert.match(alertText(tree), /重启一次 DSH/)
  assert.match(alertText(tree), /HTTP 404/)
})

test('the bundled client keeps its closure-factory handoff and own style tag', async () => {
  assert.match(sourceText, /__ModuleLoader__\.load\(\{ id: 'dsh-rea'/)
  assert.match(sourceText, /dataset\.plugin = 'dsh-rea'/)
  assert.match(sourceText, /registerSource/)
  assert.doesNotMatch(sourceText, /dsh-rea-launch/, 'the removed launch button must not linger')
})
