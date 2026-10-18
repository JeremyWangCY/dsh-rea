/**
 * Keyword gate that keeps the REA catalog out of every request until a user
 * actually asks for reverse engineering.
 *
 * WHY THIS EXISTS
 * dsh-rea bridges all 170 upstream REA tools. Their descriptions and input
 * schemas ride along with EVERY model request (436,594 bytes measured on the
 * desktop profile), which is a real per-request cost even in a session that
 * never touches a binary. This module makes that cost conditional:
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
 * @module dsh-rea/gate
 */

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
  /** Agents whose catalog must stay hidden, in creation order. */
  #gated = new Map()
  /** Agents whose current mask is installed, keyed by agent. */
  #masks = new Map()
  /** Agents that asked for the catalog; a later re-mask must never take it back. */
  #unlocked = new Set()
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
    this.#keywordUnlock = options?.keywordUnlock === true
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
   * @param agent - a gated agent.
   * @returns whether a mask is installed afterwards.
   */
  applyMask(agent) {
    const deny = this.reaToolNames()
    // Nothing bridged yet: stay gated without a mask; tools/change retries.
    if (deny.length === 0) return this.#masks.has(agent)
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
   * Stop hiding the catalog from one agent, permanently for its lifetime.
   *
   * Remembering the unlock is what keeps a later tools/change re-mask from
   * taking the tools away in the middle of a reverse-engineering task.
   * @param agent - the agent whose view is widened.
   * @returns whether the agent was gated before this call.
   */
  unlock(agent) {
    if (agent === undefined || !this.#gated.has(agent)) return false
    this.#gated.delete(agent)
    this.#unlocked.add(agent)
    const dispose = this.#masks.get(agent)
    this.#masks.delete(agent)
    if (dispose !== undefined) {
      try {
        dispose()
      } catch (error) {
        this.#log.warn('dsh-rea: could not reveal the catalog to agent "' + String(agent.id) + '": ' + String(error?.message ?? error))
      }
    }
    if (this.#onUnlock !== undefined) {
      try {
        this.#onUnlock(agent)
      } catch (error) {
        this.#log.warn('dsh-rea: unlock hook failed for agent "' + String(agent.id) + '": ' + String(error?.message ?? error))
      }
    }
    return true
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
    for (const agent of this.#gated.keys()) {
      const previous = this.#masks.get(agent)
      this.#masks.delete(agent)
      if (previous !== undefined) {
        try {
          previous()
        } catch {
          // The old generation is gone; installing the new mask is what matters.
        }
      }
      if (this.applyMask(agent)) installed += 1
    }
    return installed
  }

  /**
   * Whether this agent's existing history already asked for reverse engineering.
   *
   * A resumed session does not replay agent/inbox/inserted for stored messages,
   * so a session that unlocked the catalog yesterday would be re-masked on
   * reload - taking the tools away mid-task. The log is the durable source of
   * truth for 'the user already asked', so restored sessions re-derive the
   * unlock from it instead of relying on live traffic only.
   * @param agent - the agent whose history is inspected.
   * @returns whether a stored user prompt already unlocked the catalog.
   */
  historyUnlocks(agent) {
    try {
      const events = agent.session.snapshotEvents()
      for (const event of events) {
        // /rea is a command, so its effect is durable as a command/run record.
        // Without this a session revealed yesterday would be re-masked on
        // reload, taking the tools away from work already in progress.
        if (event.type === 'command/run' && event.data?.name === 'rea') return true
        if (!this.#keywordUnlock) continue
        if (event.type !== 'user/message') continue
        if (batchUnlocks([event.data])) return true
      }
      return false
    } catch (error) {
      // Fail open: an unreadable history must not silently hide the user's tools.
      this.#log.warn('dsh-rea: could not inspect session history, leaving the catalog visible: ' + String(error?.message ?? error))
      return true
    }
  }

  /**
   * Gate one agent unless its own history already requested reverse engineering.
   * @param agent - the agent to gate or unlock from history.
   * @returns whether the agent is now gated.
   */
  gateOrRestore(agent) {
    if (agent === undefined) return false
    if (this.historyUnlocks(agent)) {
      // Routed through unlock() so the skill registration hook still runs.
      this.#gated.set(agent, true)
      this.unlock(agent)
      return false
    }
    return this.gate(agent)
  }

  /**
   * Forget one agent without touching the registry.
   *
   * Called on agent/disposed: that agent's scope is being torn down, so its
   * registrations unwind on their own and only this bookkeeping must not leak.
   * @param agent - the agent leaving.
   */
  forget(agent) {
    this.#gated.delete(agent)
    this.#masks.delete(agent)
    this.#unlocked.delete(agent)
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
      gate.unlock(agent)
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
    },
  }
}
