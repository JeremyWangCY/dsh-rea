/**
 * Model-facing loader tools: let the model reveal REA categories itself.
 *
 * WHY THE MODEL GETS A LOADER
 * With a narrow `defaultCategories` a session starts with only a slice of the
 * catalog. When the task turns out to need another slice (a web question inside
 * a native-binary session), the model should be able to ask for it instead of
 * telling the user to run `/rea add web`. `rea_load` does that for the calling
 * agent only, and `rea_unload` hides the catalog again.
 *
 * WHY IT IS GUARDED
 * Every load changes the request prefix and costs a prompt-cache miss, and a
 * weak model will happily load everything. So one call may add at most
 * `maxPerCall` new categories, a call that changes nothing says so, and the
 * result reports how many tools and KB the load added so the cost is visible.
 * Errors are THROWN, never returned: a thrown error is a failed tool result,
 * and history replay (see ./gate.js) ignores failed calls.
 *
 * The tool names must not start with the REA prefix: the gate masks every
 * `mcp__rea__*` name, which would hide the loader from the very agent that
 * needs it.
 * @module dsh-rea/loader
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CATEGORY_IDS, describeCategories, normalizeCategories } from './categories.js'
import { LOAD_TOOL, UNLOAD_TOOL } from './directives.js'

export { LOAD_TOOL, UNLOAD_TOOL }

/** Default cap on categories one `rea_load` call may add. */
const DEFAULT_MAX_PER_CALL = 3

/**
 * Round a byte count to kilobytes with one decimal.
 * @param bytes - size in bytes.
 * @returns the size in KB.
 */
function kb(bytes) {
  return Math.round(bytes / 102.4) / 10
}

/**
 * The `rea_load` description: purpose, the loadable categories, and the cost
 * warning. `other` and denied categories are left out: the first is empty on
 * every release the coverage test passes for, the second can never be loaded,
 * and every line here rides along with every request.
 * @param denied - categories this profile never lets anyone load.
 * @returns the description text.
 */
export function loadDescription(denied) {
  return [
    'Reveal REA reverse-engineering tools by category for this session. Categories:',
    ...describeCategories(['other', ...denied]),
    'Load only what the current task needs, once per task; loaded tools appear on your next step. Loading changes the prompt and costs a cache miss, so avoid loading and unloading repeatedly.',
  ].join('\n')
}

/**
 * Register `rea_load` and `rea_unload`.
 * @param ctx - plugin context; the registrations are owned by this fiber.
 * @param options.gate - the visibility gate.
 * @param options.maxPerCall - most new categories one call may add.
 * @param options.alwaysDeny - categories never offered; defaults to the gate's own list.
 * @returns the disposer that unregisters both tools.
 */
export function registerLoaderTools(ctx, options) {
  const gate = options.gate
  const maxPerCall = options.maxPerCall ?? DEFAULT_MAX_PER_CALL
  const denied = options.alwaysDeny ?? gate.alwaysDeny
  const known = CATEGORY_IDS.filter(id => !denied.includes(id))

  const load = defineTool({
    name: LOAD_TOOL,
    description: loadDescription(denied),
    parameters: {
      categories: { type: 'array', items: { type: 'string' }, required: true, description: 'Category ids to load, e.g. ["web"].' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(LOAD_TOOL + ' needs a calling agent and has none.')
      const { valid, unknown } = normalizeCategories(args.categories)
      if (unknown.length > 0) throw new Error('Unknown REA category: ' + unknown.join(', ') + '. Known: ' + known.join(', ') + '.')
      if (valid.size === 0) throw new Error('Name at least one category. Known: ' + known.join(', ') + '.')
      const before = gate.visibility(agent)
      if (before.state === 'all') {
        return { state: 'all', loaded: before.categories, added: [], denied: [], toolsAdded: 0, kbAdded: 0, note: 'Every category is already loaded; nothing changed.' }
      }
      const fresh = CATEGORY_IDS.filter(id => valid.has(id) && !denied.includes(id) && !before.categories.includes(id))
      if (fresh.length > maxPerCall) {
        throw new Error('Load at most ' + maxPerCall + ' new categories per call (this asks for ' + fresh.length + '). Pick the ones the task needs; the user can run /rea on all for everything.')
      }
      const result = gate.reveal(agent, [...valid])
      const sizes = gate.categoryBytes()
      let toolsAdded = 0
      let bytesAdded = 0
      for (const id of result.added) {
        toolsAdded += sizes.get(id)?.tools ?? 0
        bytesAdded += sizes.get(id)?.bytes ?? 0
      }
      return {
        state: result.state,
        loaded: result.categories,
        added: result.added,
        denied: result.denied,
        toolsAdded: toolsAdded,
        kbAdded: kb(bytesAdded),
        note: result.added.length > 0 ? 'available from your next step' : 'Already loaded; nothing changed.',
      }
    },
  })

  const unload = defineTool({
    name: UNLOAD_TOOL,
    description: 'Hide every REA tool again for this session. Use it only when the reverse-engineering work is finished; reloading costs a cache miss.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error(UNLOAD_TOOL + ' needs a calling agent and has none.')
      gate.relock(agent)
      return { state: 'hidden' }
    },
  })

  const disposers = [ctx.tools.register(load), ctx.tools.register(unload)]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

