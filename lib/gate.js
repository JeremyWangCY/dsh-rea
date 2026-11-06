/**
 * Keyword gate that keeps the REA catalog out of every request until a user
 * actually asks for reverse engineering.
 *
 * WHY THIS EXISTS
 * dsh-rea bridges every upstream REA tool. Their descriptions and input
 * schemas ride along with EVERY model request (436,594 bytes measured for the
 * 170-tool REA 6.4.0 generation on the desktop profile), which is a real
 * per-request cost even in a session that never touches a binary. This module
 * makes that cost conditional:
 *
 *  - The MCP connection and its single REA process stay exactly as they were,
 *    so prompts, completions and the shared analysis session are unaffected.
 *  - Each agent gets a tools.restrict({ deny }) mask naming the current
 *    mcp__rea__* generation. Both the assembled request schemas and the
 *    generated PTC SDK prompt are projected from the same scope view, so the
 *    catalog leaves the request entirely.
 *  - The `/rea` command lifts the mask explicitly (see ./command.js), and a
 *    real user message that mentions reverse engineering lifts it by keyword.
 *    Both happen synchronously so the very turn that asks for the work already
 *    has the tools - no extra round trip and no 'call a tool you cannot see'
 *    dead end.
 *
 * WHY KEYWORDS ARE NOT THE PRIMARY SWITCH
 * Keyword inference is a guess, and a wrong guess costs the full catalog (530 KB
 * in native mode). It is also wrong precisely where it is most expensive:
 * discussing this gate necessarily names its trigger words, which is exactly
 * what happened during its own development. `/rea` is the user saying it
 * outright, so it is authoritative; keywords stay as a convenience for a user
 * who simply asks for the work.
 *
 * WHY NOT register/unregister the tools instead
 * The bridge owns registration and re-syncs on notifications/tools/list_changed.
 * A parallel register/unregister path would fight that generation swap and
 * would re-register the whole catalog into the global layer on every re-sync -
 * the very cost this removes. A restriction is the registry's own supported
 * mechanism for 'visible to some agents only': it never touches the bridge's
 * ownership, and its disposer restores the previous view exactly.
 *
 * FAILURE POSTURE
 * The gate fails OPEN for the reverse-engineering case and CLOSED for the
 * token case. If the keyword test throws, the message counts as a match (the
 * user gets the tools). If a mask cannot be installed, the error is logged and
 * the default (visible) view stands rather than leaving a half-hidden catalog.
 *
 * CATEGORIES
 * The gate is no longer all-or-nothing. An agent is in one of three states:
 * hidden (every REA tool masked), partial (only some categories revealed, see
 * ./categories.js) or all (no mask). `reveal`, `setCategories`, `unlock` and
 * `relock` move between them, `alwaysDeny` keeps chosen categories masked even
 * for a fully revealed agent, and the skill lifespan sees one unlock/relock pair
 * per hidden <-> visible transition, however many categories came and went.
 * @module dsh-rea/gate
 */

import { ALL, CATEGORY_IDS, categoryOf as defaultCategoryOf, normalizeCategories } from './categories.js'
import { LOAD_TOOL, parseReaInput, UNLOAD_TOOL } from './directives.js'

/** Tool registry change notification: the bridged name set may have changed. */
const TOOL_CHANGE_EVENT = 'tools/change'

/**
 * Words that mean 'the user wants reverse engineering', in the languages this
 * deployment actually sees (English, Chinese). Deliberately generous: a false
 * positive only costs one session's token budget, while a false negative makes
 * the feature look broken.
 */
const KEYWORDS = [
  'reverse engineer', 'reverse-engineer', 'reverse engineering', 'reverse-engineering',
  'decompile', 'decompilation', 'disassemble', 'disassembly',
  'ghidra', 'ida pro', 'binaryninja', 'binary ninja', 'hopper', 'jeb',
  // Reverse engineering / decompile / disassemble / deobfuscate / unpack.
  '\u9006\u5411', '\u53cd\u5411\u5de5\u7a0b', '\u53cd\u7f16\u8bd1', '\u53cd\u6c47\u7f16', '\u53cd\u6df7\u6dc6', '\u8131\u58f3',
]

/**
 * Binary and product artifacts. A named artifact is not by itself an analysis
 * request ('build the .exe'), but paired with a verb it is. Extensions match
 * with or without the leading dot, and the short forms match as bare words, so
 * a user never has to name a file path.
 */
const ARTIFACT_PATTERNS = [
  /\\.(?:apk|ipa|dex|jar|dll|exe|so|elf|wasm|bin|dylib|msi|sys|ocx)\b/iu,
  /\b(?:apk|ipa|dex|jar|dll|exe|wasm|dylib|firmware|electron)\b/iu,
  /\u52a0\u56fa/iu,
]

/**
 * Verbs that turn 'look at this binary' into an analysis request. An artifact
 * without one of these stays ordinary software work.
 */
const ANALYSIS_VERBS = [
  'analyze', 'analyse', 'inspect', 'examine', 'investigate', 'figure out',
  'what does', 'how does', 'crack', 'patch', 'unpack', 'bypass', 'trace',
  '\u5206\u6790', '\u770b\u770b', '\u770b\u4e00\u4e0b', '\u7814\u7a76', '\u67e5\u770b', '\u5256\u6790', '\u5ba1\u8ba1', '\u5728\u5e72\u4ec0\u4e48', '\u5e72\u4ec0\u4e48',
]

/** Phrases that are ordinary software work, not REA work, when they appear alone. */
const STOPWORDS = [
  'reverse proxy', 'reverse-proxy', 'reverse dns', 'reverse-dns',
  'reverse order', 'reverse-order', 'reverse sort', 'reverse-sort',
  'reverse the order', 'in reverse', 'reverse iterator', 'reverse array',
  'reverse string', 'reverse list', 'reverse bytes', 'reverse lookup',
]

/**
 * Escape a literal phrase for use inside a RegExp.
 * @param keyword - literal text.
 * @returns the escaped text.
 */
function escapeRegExp(keyword) {
  let out = ''
  for (const ch of keyword) {
    out += '.[]{}()*+?^$|\\'.includes(ch) ? '\\' + ch : ch
  }
  return out
}
/**
 * Build a case-insensitive, word-aware matcher for one literal phrase.
 * @param keyword - literal phrase to match.
 * @returns the compiled matcher.
 */
function exactWord(keyword) {
  const escaped = escapeRegExp(keyword)
  // CJK has no spaces, so word boundaries only apply to ASCII keywords.
  if (!/^[\x20-\x7e]+$/.test(keyword)) return new RegExp(escaped, 'iu')
  // A boundary only exists between a word and a non-word character, so it is
  // meaningful only when the phrase itself starts (ends) with a word char.
  const leading = /^\w/.test(keyword) ? '\\b' : ''
  const trailing = /\w$/.test(keyword) ? '\\b' : ''
  return new RegExp(leading + escaped + trailing, 'iu')
}

const KEYWORD_PATTERNS = KEYWORDS.map(function (keyword) { return { keyword: keyword, pattern: exactWord(keyword) } })
const VERB_PATTERNS = ANALYSIS_VERBS.map(function (verb) { return { verb: verb, pattern: exactWord(verb) } })

/**
 * Collect the plain text of one message's content blocks.
 * Tool results, images, files and reasoning blocks carry no user prose.
 * @param message - the message to read.
 * @returns its text blocks joined for matching.
 */
export function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  return parts.join('\n')
}

/**
 * Whether one message is a real user prompt.
 *
 * Only source.kind === 'user' counts. That single test excludes exactly the
 * traffic that must NOT unlock the catalog: tool results ('tool'), injected
 * context and catalogues ('plugin'), goal rounds, webhooks, and messages
 * relayed between agents ('agent-message'). A skill the user invoked by name
 * still arrives as a separate plain user message, so the user's own words are
 * what unlock it.
 * @param message - the message to classify.
 * @returns whether it is a user-authored prompt.
 */
export function isUserPrompt(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

/**
 * Whether a keyword only occurs inside a stopword phrase.
 * @param text - normalized message text.
 * @param keyword - the keyword under test.
 * @returns whether every occurrence is part of an excluded phrase.
 */
export function stopwordOnly(text, keyword) {
  let embedded = false
  for (const stopword of STOPWORDS) {
    // A keyword that appears in no stopword phrase cannot be a stopword hit.
    if (!stopword.includes(keyword)) continue
    embedded = true
    // Still present after removing every occurrence of that phrase.
    if (text.split(stopword).join('').includes(keyword)) return false
  }
  return embedded
}

/**
 * Decide whether one user message asks for reverse engineering.
 *
 * A stopword phrase suppresses a bare keyword hit in the SAME message, so
 * 'add a reverse proxy' stays a normal request while 'decompile this dll' and
 * the Chinese equivalent unlock the catalog.
 * @param text - the user's plain text.
 * @returns whether the catalog should become visible.
 */
export function mentionsReverseEngineering(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const normalized = text.toLowerCase()
  const matched = []
  for (const entry of KEYWORD_PATTERNS) if (entry.pattern.test(normalized)) matched.push(entry.keyword)
  const strong = matched.filter(function (keyword) { return !stopwordOnly(normalized, keyword) })
  if (strong.length > 0) return true
  // 'Look at this .apk' names no keyword, so pair a named artifact with an
  // analysis verb. Reaching here means every keyword hit was stopword-embedded,
  // so 'add a reverse proxy' cannot be promoted by this branch.
  const namesArtifact = ARTIFACT_PATTERNS.some(function (pattern) { return pattern.test(normalized) })
  if (!namesArtifact) return false
  return VERB_PATTERNS.some(function (entry) { return entry.pattern.test(normalized) })
}

/**
 * Whether ANY message in a batch unlocks the catalog.
 * @param messages - candidate messages.
 * @returns whether a user prompt asked for reverse engineering.
 */
export function batchUnlocks(messages) {
  for (const message of messages ?? []) {
    try {
      if (isUserPrompt(message) && mentionsReverseEngineering(messageText(message))) return true
    } catch {
      // Fail open: an unclassifiable message must not silently disable the user's tools.
      return true
    }
  }
  return false
}

/**
 * Track which agents currently see the REA catalog, and keep that view correct
 * as the bridge re-syncs its tool generation.
 *
 * The mask is a DENY list, not an allow list. tools.restrict validates every
 * name against the registry's global set and throws on an unknown name, so an
 * allow list would have to spell out the entire mcp__rea__* universe on every
 * call and would break whenever upstream added a tool. A deny list over that
 * same universe is rebuilt from the live registry whenever it changes.
 *
 * Membership is tracked independently of whether a mask is installed: the gate
 * installs before the bridge's first sync, so an agent can exist while zero REA
 * tools are registered yet. Such an agent is still gated, and the tools/change
 * handler masks it as soon as the names appear - a mask installed now would be
 * a no-op that silently let the first real generation through.
 */
export class ReaVisibilityGate {
  #ctx
  #prefix
  #log
  #onUnlock
  #onRelock
  /** Agents whose catalog must stay hidden, in creation order. */
  #gated = new Map()
  /** Agents whose current mask is installed, keyed by agent. */
  #masks = new Map()
  /** Agents that asked for the catalog; a later re-mask must never take it back. */
  #unlocked = new Set()
  /** Revealed categories of agents that are partly revealed; absent means hidden. */
  #partial = new Map()
  /** Categories that stay masked even for a fully revealed agent. */
  #alwaysDeny
  #categoryOf
  #defaultCategories
  #keywordCategories
  /**
   * Re-entrancy guard.
   *
   * tools.restrict() itself emits 'tools/change', which is the very event this
   * gate listens to. Without this flag a single mask would schedule another
   * resync, which masks again, forever. The names a mask denotes only change
   * when the BRIDGE swaps generations, so a change caused by our own mask is by
   * construction already covered.
   */
  #masking = 0
  /**
   * Whether a user message may unlock by keyword as well as by /rea.
   *
   * Off by default. Talking about the gate necessarily names its trigger words,
   * so keyword inference is exactly wrong in the conversation where a wrong
   * answer is most expensive. /rea is the user saying it outright.
   */
  #keywordUnlock = false

  /**
   * @param ctx - plugin context (global, owns the listeners).
   * @param serverName - bridge namespace, the source of the public prefix.
   * @param log - logger for contained failures.
   * @param onUnlock - called once per agent the first time it is unlocked.
   */
  constructor(ctx, serverName, log, onUnlock, options) {
    this.#ctx = ctx
    this.#prefix = 'mcp__' + serverName + '__'
    this.#log = log
    this.#onUnlock = onUnlock
    this.#onRelock = options?.onRelock
    this.#keywordUnlock = options?.keywordUnlock === true
    this.#alwaysDeny = normalizeCategories(options?.alwaysDeny ?? []).valid
    this.#categoryOf = options?.categoryOf ?? defaultCategoryOf
    this.#defaultCategories = options?.defaultCategories ?? [ALL]
    this.#keywordCategories = options?.keywordCategories ?? ['native']
  }

  /** Categories a bare `/rea` reveals. */
  get defaultCategories() {
    return this.#defaultCategories
  }

  /** Categories kept masked even from a fully revealed agent. */
  get alwaysDeny() {
    return CATEGORY_IDS.filter(id => this.#alwaysDeny.has(id))
  }

  /** Categories a keyword unlock reveals. */
  get keywordCategories() {
    return this.#keywordCategories
  }

  /** The public-name prefix naming every tool this plugin bridges. */
  get prefix() {
    return this.#prefix
  }

  /** Whether keyword inference may unlock the catalog. */
  get keywordUnlock() {
    return this.#keywordUnlock
  }

  /** Agents currently gated, gated or not, for diagnostics and tests. */
  get gatedCount() {
    return this.#gated.size
  }

  /** Agents with any REA tool visible, whether fully or partly revealed. */
  get unlockedCount() {
    return this.#unlocked.size + this.#partial.size
  }

  /** Agents with only some categories revealed, for diagnostics and tests. */
  get partialCount() {
    return this.#partial.size
  }

  /** Agents with a live mask installed. */
  get maskedCount() {
    return this.#masks.size
  }

  /**
   * Every currently registered REA tool name.
   *
   * The global view is the right source: the bridge registers globally, while
   * an agent's own restricted view hides the very names this must deny.
   * @returns the names, sorted for deterministic masks.
   */
  reaToolNames() {
    const names = []
    for (const schema of this.#ctx.tools.schemas()) {
      if (schema.name.startsWith(this.#prefix)) names.push(schema.name)
    }
    return names.sort()
  }

  /**
   * Whether one agent is currently gated (its catalog hidden or pending).
   * @param agent - the agent under test.
   * @returns whether the agent is gated.
   */
  isGated(agent) {
    return this.#gated.has(agent)
  }

  /**
   * Gate one agent: remember it, and install the mask if the names exist yet.
   *
   * Idempotent. A gated agent stays gated across re-syncs until it unlocks.
   * @param agent - the agent to gate.
   * @returns whether a mask was installed right away.
   */
  gate(agent) {
    if (agent === undefined) return false
    // An unlocked agent stays unlocked for its whole life: re-gating it would
    // take the tools away in the middle of the work it was unlocked for.
    if (this.#unlocked.has(agent)) return false
    if (this.#gated.has(agent)) return this.#masks.has(agent)
    this.#gated.set(agent, true)
    return this.applyMask(agent)
  }

  /**
   * Install or refresh one gated agent's mask against the live generation.
   *
   * Any mask already installed for this agent is disposed first. installGate
   * runs gateOrRestore over existing agents, and relock() can walk an agent back
   * through gated states more than once, so overwriting #masks blindly would
   * leak a live restriction that nothing can release.
   * @param agent - a gated agent.
   * @returns whether a mask is installed afterwards.
   */
  applyMask(agent) {
    const names = this.reaToolNames()
    // Nothing bridged yet: stay gated without a mask; tools/change retries.
    if (names.length === 0) return this.#masks.has(agent)
    const allowed = this.#allowedCategories(agent)
    const deny = names.filter(name => !allowed.has(this.#categoryOf(name.slice(this.#prefix.length))))
    // Everything this agent may see is allowed: no mask is the exact view.
    if (deny.length === 0) {
      this.#disposeMask(agent)
      return false
    }
    if (this.#masks.has(agent)) this.#disposeMask(agent)
    this.#masking += 1
    try {
      const dispose = agent.ctx.tools.restrict({ deny: deny })
      this.#masks.set(agent, dispose)
      return true
    } catch (error) {
      this.#log.warn('dsh-rea: could not hide the catalog from agent "' + String(agent.id) + '": ' + String(error?.message ?? error))
      this.#masks.delete(agent)
      return false
    } finally {
      this.#masking -= 1
    }
  }

  /**
   * The categories one agent may see: what it revealed minus `alwaysDeny`.
   * @param agent - the agent under test.
   * @returns the allowed category ids; a fully revealed agent gets every id.
   */
  #allowedCategories(agent) {
    const revealed = this.#unlocked.has(agent) ? CATEGORY_IDS : (this.#partial.get(agent) ?? [])
    return new Set([...revealed].filter(id => !this.#alwaysDeny.has(id)))
  }

  /**
   * Whether an agent's view needs a mask at all.
   *
   * Gated agents always do. A fully revealed agent does only when `alwaysDeny`
   * keeps some category hidden from it.
   * @param agent - the agent under test.
   * @returns whether a mask belongs on this agent.
   */
  #needsMask(agent) {
    return this.#gated.has(agent) || (this.#unlocked.has(agent) && this.#alwaysDeny.size > 0)
  }

  /**
   * Release one agent's installed mask, if any, and forget it.
   *
   * Contained: a disposer that throws must not stop the caller from updating
   * the rest of its bookkeeping.
   * @param agent - the agent whose mask is released.
   * @returns the released disposer, or undefined when none was installed.
   */
  #disposeMask(agent) {
    const dispose = this.#masks.get(agent)
    this.#masks.delete(agent)
    if (dispose === undefined) return undefined
    // A disposer emits 'tools/change' just like restrict() does. Unguarded, that
    // event re-masks this very agent from inside the release and the caller then
    // installs a second mask on top, leaking the first.
    this.#masking += 1
    try {
      dispose()
    } catch (error) {
      this.#log.warn('dsh-rea: could not release the catalog mask for agent "' + String(agent.id) + '": ' + String(error?.message ?? error))
    } finally {
      this.#masking -= 1
    }
    return dispose
  }

  /**
   * Where one agent stands: hidden, partly revealed, or fully revealed.
   * @param agent - the agent under test.
   * @returns its state and the categories it can see (`alwaysDeny` excluded).
   */
  visibility(agent) {
    if (this.#unlocked.has(agent)) return { state: 'all', categories: [...this.#allowedCategories(agent)] }
    const partial = this.#partial.get(agent)
    if (partial !== undefined) return { state: 'partial', categories: CATEGORY_IDS.filter(id => partial.has(id) && !this.#alwaysDeny.has(id)) }
    return { state: 'hidden', categories: [] }
  }

  /**
   * Reveal categories for one agent, on top of what it already sees.
   *
   * `all` (or naming every category) is a full reveal. Categories in
   * `alwaysDeny` are dropped and reported rather than revealed. An agent the
   * gate has not seen yet is gated first, so the very first call both hides and
   * reveals in one step.
   * @param agent - the agent whose view is widened.
   * @param categories - ids, `all`, or a string a user typed.
   * @returns the resulting state, what is visible, what was newly added, and what `alwaysDeny` refused.
   */
  reveal(agent, categories) {
    return this.#apply(agent, categories, false)
  }

  /**
   * Replace the categories one agent sees.
   *
   * Used by `/rea on <categories>` and by history replay. An empty (or fully
   * denied) set is a relock.
   * @param agent - the agent whose view is replaced.
   * @param categories - ids, `all`, or a string a user typed.
   * @returns the same shape as reveal().
   */
  setCategories(agent, categories) {
    return this.#apply(agent, categories, true)
  }

  /**
   * Shared body of reveal() and setCategories().
   * @param agent - the agent whose view changes.
   * @param categories - requested categories.
   * @param replace - whether the request replaces the current set or joins it.
   * @returns the outcome described on reveal().
   */
  #apply(agent, categories, replace) {
    if (agent === undefined) return { state: 'hidden', categories: [], added: [], denied: [] }
    const { valid } = normalizeCategories(categories)
    const denied = CATEGORY_IDS.filter(id => valid.has(id) && this.#alwaysDeny.has(id))
    const before = this.visibility(agent)
    const requested = CATEGORY_IDS.filter(id => valid.has(id) && !this.#alwaysDeny.has(id))
    if (valid.size === CATEGORY_IDS.length) {
      // Already fully revealed: re-entering would re-install an identical
      // alwaysDeny mask and emit two tools/change events for nothing.
      if (before.state !== 'all') this.#enter(agent, 'all')
    } else if (replace) {
      if (requested.length === 0) this.#enter(agent, 'hidden')
      else this.#enter(agent, 'partial', new Set(requested))
    } else if (before.state !== 'all' && requested.some(id => !before.categories.includes(id))) {
      this.#enter(agent, 'partial', new Set([...before.categories, ...requested]))
    } else if (before.state === 'hidden' && !this.#gated.has(agent)) {
      // Nothing to reveal, but an unseen agent must still be masked.
      this.#enter(agent, 'hidden')
    }
    const after = this.visibility(agent)
    return {
      state: after.state,
      categories: after.categories,
      added: after.categories.filter(id => !before.categories.includes(id)),
      denied: denied,
    }
  }

  /**
   * Move one agent to a state, install or drop its mask, and run the hooks.
   *
   * The one place the unlock/relock hooks fire: onUnlock when the agent leaves
   * hidden, onRelock when it returns there. partial <-> all never fires either,
   * so the skill is registered once however an agent widens its view.
   * @param agent - the agent to move.
   * @param state - `hidden`, `partial` or `all`.
   * @param categories - the revealed set, for `partial`.
   */
  #enter(agent, state, categories) {
    const was = this.visibility(agent).state
    this.#partial.delete(agent)
    if (state === 'all') {
      this.#gated.delete(agent)
      this.#unlocked.add(agent)
    } else {
      this.#unlocked.delete(agent)
      this.#gated.set(agent, true)
      if (state === 'partial') this.#partial.set(agent, categories)
    }
    if (this.#needsMask(agent)) this.applyMask(agent)
    else this.#disposeMask(agent)
    if (was === 'hidden' && state !== 'hidden') this.#runHook(this.#onUnlock, agent, 'unlock')
    else if (was !== 'hidden' && state === 'hidden') this.#runHook(this.#onRelock, agent, 'relock')
  }

  /**
   * Run one lifecycle hook, contained.
   * @param hook - the hook, if any.
   * @param agent - the agent the hook is about.
   * @param label - hook name for the warning.
   */
  #runHook(hook, agent, label) {
    if (hook === undefined) return
    const warn = (error) => {
      this.#log.warn('dsh-rea: ' + label + ' hook failed for agent "' + String(agent.id) + '": ' + String(error?.message ?? error))
    }
    try {
      const pending = hook(agent)
      // An async hook cannot be caught by this try/catch: its rejection would
      // surface as an unhandled rejection, which the Host treats as fatal and
      // turns into an exit-1 activation failure. Contained here so a failing
      // hook stays a logged warning.
      if (pending !== undefined && typeof pending.then === 'function') pending.then(undefined, warn)
    } catch (error) {
      warn(error)
    }
  }

  /**
   * Stop hiding the whole catalog from one agent.
   *
   * Remembering the reveal is what keeps a later tools/change re-mask from
   * taking the tools away in the middle of a reverse-engineering task. Only a
   * gated (hidden or partial) agent changes.
   * @param agent - the agent whose view is widened.
   * @returns whether the agent was gated before this call.
   */
  unlock(agent) {
    if (agent === undefined || !this.#gated.has(agent)) return false
    this.#enter(agent, 'all')
    return true
  }

  /**
   * Hide the catalog again for one agent that sees any of it.
   *
   * The counterpart of unlock(), and the reason `#unlocked` cannot simply be an
   * irreversible set: `/rea off` must be able to take the tools back for the
   * session that asked for them. A partly revealed agent relocks too.
   * @param agent - the agent whose view is narrowed again.
   * @returns whether the agent is gated afterwards.
   */
  relock(agent) {
    if (agent === undefined) return false
    if (this.visibility(agent).state === 'hidden') return this.#gated.has(agent)
    this.#enter(agent, 'hidden')
    return true
  }

  /**
   * Size of every category in the live catalog.
   *
   * Bytes are the model-side schema cost, measured the way verify/measure.mjs
   * does: the JSON of each tool's name, description and parameters.
   * @returns the categories that have tools, in display order.
   */
  categoryBytes() {
    const totals = new Map()
    for (const schema of this.#ctx.tools.schemas()) {
      if (!schema.name.startsWith(this.#prefix)) continue
      const id = this.#categoryOf(schema.name.slice(this.#prefix.length))
      const bytes = Buffer.byteLength(JSON.stringify({ name: schema.name, description: schema.description ?? '', parameters: schema.parameters }))
      const total = totals.get(id) ?? { tools: 0, bytes: 0 }
      totals.set(id, { tools: total.tools + 1, bytes: total.bytes + bytes })
    }
    return new Map(CATEGORY_IDS.filter(id => totals.has(id)).map(id => [id, totals.get(id)]))
  }

  /**
   * Re-derive every gated agent's mask after the bridge swapped generations.
   *
   * A re-sync registers a NEW set of names, so the previous deny list no longer
   * covers the catalog. Agents that unlocked are absent from #gated and keep
   * their tools.
   * @returns the number of agents whose mask now covers the live generation.
   */
  resync() {
    // Our own restrict() calls emit 'tools/change'; ignoring those is what keeps
    // a re-sync from recursing into itself.
    if (this.#masking > 0) return 0
    this.#masking += 1
    try {
      return this.#resyncMasks()
    } finally {
      this.#masking -= 1
    }
  }

  /**
   * The actual re-mask pass, run under the re-entrancy guard.
   * @returns the number of agents whose mask now covers the live generation.
   */
  #resyncMasks() {
    let installed = 0
    // Gated agents (hidden or partial) always; fully revealed ones only when
    // alwaysDeny still masks some category for them.
    for (const agent of [...this.#gated.keys(), ...this.#unlocked]) {
      if (!this.#needsMask(agent)) continue
      // The old generation is gone, so its disposer may throw; that must not
      // stop the new mask from being installed.
      this.#disposeMask(agent)
      if (this.applyMask(agent)) installed += 1
    }
    return installed
  }

  /**
   * What this agent's existing history says its REA view should be.
   *
   * A resumed session does not replay agent/inbox/inserted for stored messages,
   * so a session that revealed categories yesterday would be re-masked on
   * reload - taking the tools away mid-task. The log is the durable source of
   * truth, so restored sessions re-derive their view from it instead of relying
   * on live traffic only.
   *
   * The events are REPLAYED in order, never latched: the last word decides.
   * `/rea` and `/rea on` reveal the default categories, `/rea on <cats>`
   * replaces the set, `/rea add <cats>` joins it, `/rea off` hides, and
   * `/rea status` changes nothing. A successful `rea_load` joins its categories
   * and a successful `rea_unload` hides, paired by call id (or read from one
   * `tool/ptc-dispatch` record when the model called them through run_code); a call without a
   * successful result never happened. Treating any `/rea` record as an unlock
   * once put the whole catalog back into every reload of any session that had
   * ever run one - the 413 preflight_compress_failed that motivated the replay.
   *
   * A bare `/rea` and a keyword message are stored without the categories they
   * revealed, so they replay through the CURRENT defaultCategories and
   * keywordCategories: after either setting changes, a resumed session follows
   * the new value. Explicit `/rea on|add <cats>` and `rea_load` calls name their
   * categories and replay exactly.
   * @param agent - the agent whose history is inspected.
   * @returns the state and categories the history leaves behind.
   */
  historyState(agent) {
    try {
      const events = agent.session.snapshotEvents()
      let revealed = new Set()
      const pending = new Map()
      for (const event of events) {
        const data = event.data
        if (event.type === 'command/run' && data?.name === 'rea') {
          const parsed = parseReaInput(String(data?.args ?? ''))
          if (parsed.directive === 'off') revealed = new Set()
          else if (parsed.directive === 'enable') revealed = this.#join(revealed, this.#defaultCategories)
          else if (parsed.directive === 'add' || parsed.directive === 'set') {
            const { valid, unknown } = normalizeCategories(parsed.categories)
            // The handler refuses a list with an unknown id without applying any of it.
            if (unknown.length > 0) continue
            revealed = parsed.directive === 'set' ? valid : this.#join(revealed, valid)
          }
          continue
        }
        // run_code (PTC) settles a nested call as one self-contained record, with
        // no separate tool/call + tool/result pair to match up.
        if (event.type === 'tool/ptc-dispatch' && (data?.name === LOAD_TOOL || data?.name === UNLOAD_TOOL)) {
          if (data.isError !== false) continue
          if (data.name === UNLOAD_TOOL) {
            revealed = new Set()
            continue
          }
          const categories = this.#loadedCategories(data)
          if (categories !== undefined) revealed = this.#join(revealed, categories)
          continue
        }
        if (event.type === 'tool/call' && (data?.name === LOAD_TOOL || data?.name === UNLOAD_TOOL)) {
          pending.set(data.callId, data)
          continue
        }
        if (event.type === 'tool/result') {
          const result = data?.message
          const call = pending.get(result?.toolCallId)
          if (call === undefined || result?.isError !== false) continue
          pending.delete(result.toolCallId)
          if (call.name === UNLOAD_TOOL) {
            revealed = new Set()
            continue
          }
          const categories = this.#loadedCategories(call)
          if (categories !== undefined) revealed = this.#join(revealed, categories)
          continue
        }
        if (this.#keywordUnlock && event.type === 'user/message' && batchUnlocks([data])) {
          revealed = this.#join(revealed, this.#keywordCategories)
        }
      }
      const categories = CATEGORY_IDS.filter(id => revealed.has(id) && !this.#alwaysDeny.has(id))
      if (revealed.size === CATEGORY_IDS.length) return { state: 'all', categories: categories }
      return { state: categories.length > 0 ? 'partial' : 'hidden', categories: categories }
    } catch (error) {
      // Fail CLOSED. An unreadable history must not reveal a catalog nobody
      // asked for: the cost of a wrong "hidden" is one `/rea`, while a wrong
      // "revealed" is the whole catalogue on every request, silently.
      this.#log.warn('dsh-rea: could not inspect session history, keeping the catalog hidden: ' + String(error?.message ?? error))
      return { state: 'hidden', categories: [] }
    }
  }

  /**
   * The union of a replayed category set and a request.
   * @param revealed - categories revealed so far.
   * @param categories - a set of valid ids, or ids, `all`, or a string to normalize.
   * @returns a new set.
   */
  #join(revealed, categories) {
    const valid = categories instanceof Set ? categories : normalizeCategories(categories).valid
    return new Set([...revealed, ...valid])
  }

  /**
   * The categories a stored `rea_load` call asked for.
   * @param call - the stored tool/call event data.
   * @returns the requested ids, or undefined when its arguments are unusable.
   */
  #loadedCategories(call) {
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
      return normalizeCategories(args?.categories ?? []).valid
    } catch (error) {
      this.#log.warn('dsh-rea: ignoring a stored ' + LOAD_TOOL + ' call with unreadable arguments: ' + String(error?.message ?? error))
      return undefined
    }
  }

  /**
   * Whether this agent's existing history left any REA tool visible.
   * @param agent - the agent whose history is inspected.
   * @returns whether the replayed state is not hidden.
   */
  historyUnlocks(agent) {
    return this.historyState(agent).state !== 'hidden'
  }

  /**
   * Gate one agent, or restore the view its own history left behind.
   * @param agent - the agent to gate or restore from history.
   * @returns whether the agent is now gated (hidden or partly revealed).
   */
  gateOrRestore(agent) {
    if (agent === undefined) return false
    const { state, categories } = this.historyState(agent)
    // Entered directly rather than gate()-then-reveal so a restored agent gets
    // exactly one mask, and the unlock hook (skill registration) still runs.
    if (state === 'all') {
      this.#enter(agent, 'all')
      return false
    }
    if (state === 'partial') {
      this.#enter(agent, 'partial', new Set(categories))
      return this.#masks.has(agent)
    }
    return this.gate(agent)
  }

  /**
   * Forget one agent without touching the registry.
   *
   * Called on agent/disposed: that agent's scope is being torn down, so its
   * registrations unwind on their own and only this bookkeeping must not leak.
   * An agent that could see REA tools counts as relocked on its way out, or the
   * skill would stay registered after the last revealed session closed.
   * @param agent - the agent leaving.
   */
  forget(agent) {
    const was = this.visibility(agent).state
    this.#gated.delete(agent)
    this.#masks.delete(agent)
    this.#unlocked.delete(agent)
    this.#partial.delete(agent)
    if (was !== 'hidden') this.#runHook(this.#onRelock, agent, 'relock')
  }

  /**
   * Release every mask this gate installed and forget every agent.
   *
   * Masks are restrictions on each agent's own scope, not on the plugin fiber,
   * so a plugin reload does not release them. Left behind, a mask keeps denying
   * names that the next gate instance later reveals.
   */
  releaseAll() {
    for (const agent of [...this.#masks.keys()]) this.#disposeMask(agent)
    this.#gated.clear()
    this.#unlocked.clear()
    this.#partial.clear()
  }
}

/**
 * Install the gate: hide the catalog from every agent, then reveal it only for
 * agents whose user prompt asked for reverse engineering.
 *
 * @param ctx - plugin context; listeners are owned by this fiber.
 * @param options.serverName - bridge namespace (public prefix source).
 * @param options.onUnlock - per-agent hook run the first time an agent unlocks.
 * @param options.log - logger for contained failures.
 * @returns the gate plus its own disposer for ordered teardown.
 */
export function installGate(ctx, options) {
  const log = options.log ?? ctx.logger
  const gate = new ReaVisibilityGate(ctx, options.serverName, log, options.onUnlock, options)

  // The catalog may be empty when the gate mounts, and a re-sync replaces every
  // name: either way this handler is what keeps gated agents in step.
  const onToolsChange = function () {
    try {
      gate.resync()
    } catch (error) {
      log.warn('dsh-rea: catalog visibility refresh failed: ' + String(error?.message ?? error))
    }
  }

  // Fires synchronously inside Agent.send(), BEFORE wakeDriver() and therefore
  // before systemPrompt.assemble: unlocking here is visible to the very turn
  // the message starts.
  const onInserted = function (payload) {
    const agent = payload?.agent
    if (agent === undefined) return
    try {
      if (!gate.keywordUnlock) return
      if (!batchUnlocks([payload.message])) return
      gate.reveal(agent, gate.keywordCategories)
    } catch (error) {
      log.warn('dsh-rea: could not reveal the catalog: ' + String(error?.message ?? error))
    }
  }

  // First sight of an agent: gate it before its first request is assembled.
  const onCreated = function (payload) {
    try {
      gate.gateOrRestore(payload?.agent)
    } catch (error) {
      log.warn('dsh-rea: could not hide the catalog: ' + String(error?.message ?? error))
    }
  }

  const disposers = [
    ctx.on(TOOL_CHANGE_EVENT, onToolsChange),
    ctx.on('agent/inbox/inserted', onInserted),
    ctx.on('agent/created', onCreated),
    ctx.on('agent/disposed', function (payload) { gate.forget(payload?.agent) }),
  ]

  // Agents that already exist when the gate is (re)mounted, e.g. an HMR reload
  // inside a live session: gate them now rather than at their next turn.
  try {
    for (const agent of ctx.agents.list()) gate.gateOrRestore(agent)
  } catch (error) {
    log.warn('dsh-rea: could not hide the catalog from existing agents: ' + String(error?.message ?? error))
  }

  return {
    gate: gate,
    /** Re-derive masks after the initial bridge sync. */
    resync: onToolsChange,
    dispose: function () {
      const reversed = disposers.slice().reverse()
      for (const dispose of reversed) {
        try {
          dispose()
        } catch {
          // Listener removal after fiber teardown is not actionable.
        }
      }
      // Listeners first, so releasing the masks cannot re-mask anyone.
      gate.releaseAll()
    },
  }
}
