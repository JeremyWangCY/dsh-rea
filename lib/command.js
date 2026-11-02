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
 * @module dsh-rea/command
 */

import { randomUUID } from 'node:crypto'

/** Name of the exposing command, without the leading slash. */
export const COMMAND_NAME = 'rea'

/** Directives accepted as the whole input, never as the first word of a task. */
const DIRECTIVES = ['on', 'off', 'status']

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
 * Split the text after `/rea` into a directive and the request to forward.
 *
 * Only an exact single word is a directive, so `/rea status of this binary`
 * stays a request rather than a status query.
 * @param rawInput - text following the command name, separator included.
 * @returns the directive and the remaining request text.
 */
export function parseReaInput(rawInput) {
  const trimmed = (typeof rawInput === 'string' ? rawInput : '').trim()
  if (trimmed.length === 0) return { directive: 'enable', request: '' }
  const word = trimmed.toLowerCase()
  // 'on' and a bare '/rea' mean the same thing: reveal, then do nothing else.
  if (DIRECTIVES.includes(word)) return { directive: word === 'on' ? 'enable' : word, request: '' }
  return { directive: 'enable', request: trimmed }
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
    description: 'reveal the REA reverse-engineering tools for this session, then run the request',
    input: { hint: '[on|off|status] [request]' },
    recordInput: true,
    handler(invocation) {
      const parsed = parseReaInput(invocation.rawInput)
      const agent = invocation.agent
      try {
        if (parsed.directive === 'status') {
          const state = gate.isGated(agent) ? 'hidden' : 'revealed'
          return {
            kind: 'success',
            text: state === 'revealed'
              ? 'REA catalog: revealed for this session.'
              : 'REA catalog: hidden. Run /rea to reveal it.',
          }
        }
        if (parsed.directive === 'off') {
          // Re-hiding is supported, and is durable: the record replayed on a
          // reload keeps the session hidden. It stays a deliberate act by the
          // user who owns the session, so a mid-task `/rea off` is their call.
          if (gate.isGated(agent)) return { kind: 'success', text: 'REA catalog: already hidden.' }
          gate.relock(agent)
          return { kind: 'success', text: 'REA catalog hidden for this session. Run /rea to reveal it again.' }
        }
        gate.unlock(agent)
        if (parsed.request.length === 0) {
          return {
            kind: 'success',
            text: 'REA catalog revealed for this session. Describe the binary or behavior you want analyzed.',
          }
        }
        agent.followup(createPromptMessage(parsed.request))
        return { kind: 'success', text: 'REA catalog revealed; running: ' + parsed.request }
      } catch (error) {
        log.warn('dsh-rea: /rea failed: ' + String(error?.message ?? error))
        return { kind: 'error', text: 'Could not reveal the REA catalog: ' + String(error?.message ?? error) }
      }
    },
  })
}
