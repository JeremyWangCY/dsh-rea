/**
 * The `/rea` input grammar, shared by the command and by history replay.
 *
 * It lives apart from ./command.js and ./gate.js so both can import it without
 * a cycle, and so a live `/rea add web` and the stored `command/run` record that
 * replay reads back are parsed by the very same function: the two cannot drift.
 * @module dsh-rea/directives
 */

import { ALL, CATEGORY_IDS } from './categories.js'

/** Model tool that reveals categories (see ./loader.js). */
export const LOAD_TOOL = 'rea_load'

/** Model tool that hides the catalog again (see ./loader.js). */
export const UNLOAD_TOOL = 'rea_unload'

/** Ids a `/rea on|add` list may name by default: every category plus `all`. */
const DEFAULT_KNOWN = new Set([...CATEGORY_IDS, ALL])

/** `on|add` followed by the rest of the line. */
const LIST_DIRECTIVE = /^(on|add)\s+(\S[\s\S]*)$/i

/** A list whose every separator is a comma: `native,android`, `web, wasm`. */
const COMMA_LIST = /^[\w-]+(?:\s*,\s*[\w-]+)+$/

/**
 * Split the text after `/rea` into a directive and the request to forward.
 *
 * Directives:
 *  - `enable`: reveal the configured default categories (`categories` is null).
 *  - `set`: replace the revealed categories with `categories`.
 *  - `add`: reveal `categories` on top of what is already revealed.
 *  - `off`, `status` and `list`: exact single words only.
 *
 * `on` and `add` take a category list only when every word is a known category
 * (or the list is written with commas, so a typo reaches the handler's error
 * instead of being forwarded). Anything else after them stays a request, which
 * keeps `/rea on this binary` and `/rea add a test` meaning what they say.
 * @param rawInput - text following the command name, separator included.
 * @param knownCategories - ids that count as categories; defaults to all ids and `all`.
 * @returns the directive, its category list (or null) and the request to forward.
 */
export function parseReaInput(rawInput, knownCategories) {
  const known = knownCategories === undefined ? DEFAULT_KNOWN : new Set(knownCategories)
  const trimmed = (typeof rawInput === 'string' ? rawInput : '').trim()
  const word = trimmed.toLowerCase()
  if (word.length === 0 || word === 'on') return { directive: 'enable', categories: null, request: '' }
  if (word === 'off' || word === 'status' || word === 'list') return { directive: word, categories: null, request: '' }
  const match = LIST_DIRECTIVE.exec(trimmed)
  if (match !== null) {
    const rest = match[2].trim()
    const tokens = [...new Set(rest.toLowerCase().split(/[\s,]+/).filter(token => token.length > 0))]
    if (tokens.length > 0 && (tokens.every(token => known.has(token)) || COMMA_LIST.test(rest))) {
      return { directive: match[1].toLowerCase() === 'on' ? 'set' : 'add', categories: tokens, request: '' }
    }
  }
  return { directive: 'enable', categories: null, request: trimmed }
}
