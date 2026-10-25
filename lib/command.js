/**
 * The `/rea` command: an explicit, greppable way to reveal the catalog.
 *
 * WHY A COMMAND AND NOT ONLY KEYWORDS
 * Keyword inference guesses the user's intent, and a wrong guess costs 530 KB
 * of tool schemas in native mode (~67 KB in PTC). The guess is also unavoidable
 * where it is most wrong: talking ABOUT the gate necessarily mentions the words
 * that trigger it. A slash command is the user saying it outright, so it is the
 * primary switch and keywords remain only a convenience.
 *
 * WHY IT FORWARDS A MESSAGE
 * A resolved command never reaches the model: the composer submits the line to
 * the command registry and the text is consumed there. `/rea look at this dll`
 * must therefore queue the remaining text as an ordinary user message, or the
 * user's actual request is silently swallowed. That message also unlocks the
 * catalog: agent.followup() emits agent/inbox/inserted synchronously before the
 * new turn assembles, so the gate's existing listener grants the tools to that
 * very turn.
 *
 * CATEGORIES
 * A bare `/rea` reveals the configured default categories (everything unless
 * the profile narrows it); `/rea on <cats>` replaces the revealed set,
 * `/rea add <cats>` widens it, and `/rea status` reports what is loaded and
 * what each remaining category would cost.
 * @module dsh-rea/command
 */

import { randomUUID } from 'node:crypto'
import { ALL, CATEGORIES, CATEGORY_IDS, normalizeCategories } from './categories.js'
import { parseReaInput } from './directives.js'

export { parseReaInput }

/** Name of the exposing command, without the leading slash. */
export const COMMAND_NAME = 'rea'

/**
 * Build one plain user message carrying the user's own words.
 *
 * The shape mirrors @deepseek-ai/dsh-llm's createUserMessage: an id plus role,
 * content and source. It is constructed here rather than imported so the plugin
 * needs no dependency on the LLM package for one opaque identity field.
 * @param text - the user's request text.
 * @param mint - id source, injected for deterministic tests.
 * @returns a frozen user message the agent inbox accepts.
 */
export function createPromptMessage(text, mint = randomUUID) {
  return Object.freeze({
    id: mint(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * Format a byte count for status text.
 * @param bytes - size in bytes.
 * @returns whole kilobytes, e.g. `61 KB`.
 */
function kb(bytes) {
  return kbNumber(bytes) + ' KB'
}

/**
 * Whole kilobytes, at least one.
 * @param bytes - size in bytes.
 * @returns the number of KB.
 */
function kbNumber(bytes) {
  return Math.max(1, Math.round(bytes / 1024))
}

/**
 * Describe where one agent stands, for `/rea status`.
 *
 * Sizes are the model-side schema bytes from the gate's live catalog, so the
 * numbers answer the only question that matters when picking categories: what
 * does this cost on every request.
 * @param gate - the visibility gate.
 * @param agent - the agent asking.
 * @returns the multi-line status text.
 */
function statusText(gate, agent) {
  const { state, categories } = gate.visibility(agent)
  const sizes = gate.categoryBytes()
  const masked = gate.alwaysDeny
  const lines = []
  if (state === 'hidden') {
    lines.push('REA catalog: hidden. Run /rea to reveal ' + gate.defaultCategories.join(', ') + '.')
  } else {
    let tools = 0
    let bytes = 0
    for (const id of categories) {
      tools += sizes.get(id)?.tools ?? 0
      bytes += sizes.get(id)?.bytes ?? 0
    }
    const shown = state === 'all' ? 'revealed, all categories' : 'partial (' + categories.join(', ') + ')'
    lines.push('REA catalog: ' + shown + ' \u2014 ' + tools + ' tools, ' + kb(bytes))
  }
  if (state !== 'all') {
    const rest = [...sizes].filter(([id]) => !categories.includes(id) && !masked.includes(id))
      .sort((left, right) => right[1].bytes - left[1].bytes)
      .map(([id, size]) => id + ' ' + kb(size.bytes))
    if (rest.length > 0) lines.push('Available: ' + rest.join(' \u00b7 '))
    lines.push('Use /rea ' + (state === 'hidden' ? 'on <category>' : 'add <category>') + ' or /rea on all. /rea list describes each category.')
  }
  if (masked.length > 0) lines.push('Masked by this profile (alwaysDeny): ' + masked.join(', ') + '.')
  return lines.join('\n')
}

/**
 * Describe every category, for `/rea list`.
 *
 * Status shows only names and sizes; this answers "what is in each one", which is
 * what you need to know before choosing what to add. A category with no tools in
 * the live catalog is left out, and so is one this profile never lets anyone load.
 * @param gate - the visibility gate.
 * @param agent - the agent asking.
 * @returns the multi-line list text.
 */
function listText(gate, agent) {
  const { categories } = gate.visibility(agent)
  const sizes = gate.categoryBytes()
  const masked = gate.alwaysDeny
  const ids = CATEGORY_IDS.filter(id => sizes.has(id) && !masked.includes(id))
  const width = Math.max(...ids.map(id => id.length))
  const loaded = gate.visibility(agent).state === 'all' ? 'all' : (categories.length > 0 ? categories.join(', ') : 'none')
  const lines = ['REA categories (loaded: ' + loaded + ')']
  for (const id of ids) {
    const { tools, bytes } = sizes.get(id)
    const mark = categories.includes(id) ? '* ' : '  '
    lines.push(mark + id.padEnd(width) + '  ' + String(tools).padStart(3) + (tools === 1 ? ' tool ' : ' tools') + '  ' + String(kbNumber(bytes)).padStart(4) + ' KB  ' + CATEGORIES[id].description)
  }
  if (masked.length > 0) lines.push('Masked by this profile (alwaysDeny): ' + masked.join(', ') + '.')
  lines.push('Use /rea add <category>, /rea on <cats> or /rea on all. * = loaded.')
  return lines.join('\n')
}

/**
 * Describe the outcome of a reveal for the user.
 * @param result - what the gate reported.
 * @returns the sentence.
 */
function revealedText(result) {
  let text
  if (result.state === 'all') text = 'REA catalog revealed for this session.'
  else if (result.state === 'partial') text = 'REA catalog revealed: ' + result.categories.join(', ') + '. Use /rea add <category> for more.'
  else text = 'No REA tools were revealed.'
  if (result.denied.length > 0) text += ' Not available in this profile (alwaysDeny): ' + result.denied.join(', ') + '.'
  return text
}

/**
 * Register the `/rea` command.
 *
 * The handler is the only place that decides, per invocation, whether the
 * catalog is revealed. It runs with the exact receiving agent, so the reveal is
 * scoped to that agent and unwinds with it.
 * @param ctx - plugin context; the registration is owned by this fiber.
 * @param options.gate - the visibility gate.
 * @param options.log - logger for contained failures.
 * @returns the disposer that unregisters the command.
 */
export function registerReaCommand(ctx, options) {
  const gate = options.gate
  const log = options.log ?? ctx.logger
  return ctx.commands.register({
    name: COMMAND_NAME,
    description: 'reveal REA reverse-engineering tool categories for this session, then run the request',
    input: { hint: '[on [cats]|add <cats>|off|status|list] [request]' },
    recordInput: true,
    handler(invocation) {
      const parsed = parseReaInput(invocation.rawInput)
      const agent = invocation.agent
      try {
        if (parsed.directive === 'status') return { kind: 'success', text: statusText(gate, agent) }
        if (parsed.directive === 'list') return { kind: 'success', text: listText(gate, agent) }
        if (parsed.directive === 'off') {
          // Re-hiding is supported, and is durable: the record replayed on a
          // reload keeps the session hidden. It stays a deliberate act by the
          // user who owns the session, so a mid-task `/rea off` is their call.
          if (gate.visibility(agent).state === 'hidden') return { kind: 'success', text: 'REA catalog: already hidden.' }
          gate.relock(agent)
          return { kind: 'success', text: 'REA catalog hidden for this session. Run /rea to reveal it again.' }
        }
        if (parsed.categories !== null) {
          // Refuse the whole list when any id is unknown: a half-applied
          // `/rea add web,wsm` would reveal a set nobody asked for.
          const { unknown } = normalizeCategories(parsed.categories)
          if (unknown.length > 0) {
            return { kind: 'error', text: 'Unknown REA category: ' + unknown.join(', ') + '. Known: ' + [...CATEGORY_IDS, ALL].join(', ') + '.' }
          }
          const result = parsed.directive === 'set' ? gate.setCategories(agent, parsed.categories) : gate.reveal(agent, parsed.categories)
          return { kind: 'success', text: revealedText(result) }
        }
        const result = gate.reveal(agent, gate.defaultCategories)
        if (parsed.request.length === 0) {
          return { kind: 'success', text: revealedText(result) + ' Describe the binary or behavior you want analyzed.' }
        }
        agent.followup(createPromptMessage(parsed.request))
        return { kind: 'success', text: revealedText(result) + ' Running: ' + parsed.request }
      } catch (error) {
        log.warn('dsh-rea: /rea failed: ' + String(error?.message ?? error))
        return { kind: 'error', text: 'Could not reveal the REA catalog: ' + String(error?.message ?? error) }
      }
    },
  })
}
