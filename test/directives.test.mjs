import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReaInput } from '../lib/directives.js'

const enable = (request = '') => ({ directive: 'enable', categories: null, request })

test('an empty input and a bare on enable the default categories', () => {
  assert.deepEqual(parseReaInput(''), enable())
  assert.deepEqual(parseReaInput('   '), enable())
  assert.deepEqual(parseReaInput(undefined), enable())
  assert.deepEqual(parseReaInput(' on'), enable())
  assert.deepEqual(parseReaInput('ON'), enable())
})

test('off and status are exact single words', () => {
  assert.deepEqual(parseReaInput('off'), { directive: 'off', categories: null, request: '' })
  assert.deepEqual(parseReaInput(' Status '), { directive: 'status', categories: null, request: '' })
  assert.deepEqual(parseReaInput('status of this binary'), enable('status of this binary'))
  assert.deepEqual(parseReaInput('off by one in this binary'), enable('off by one in this binary'))
})

test('on <categories> sets, with commas, spaces or both, in any case', () => {
  const set = (...categories) => ({ directive: 'set', categories, request: '' })
  assert.deepEqual(parseReaInput(' on native,android'), set('native', 'android'))
  assert.deepEqual(parseReaInput('on native android'), set('native', 'android'))
  assert.deepEqual(parseReaInput('on Native, ANDROID'), set('native', 'android'))
  assert.deepEqual(parseReaInput('on native native,native'), set('native'))
  assert.deepEqual(parseReaInput('on all'), set('all'))
})

test('add <categories> joins', () => {
  assert.deepEqual(parseReaInput('add web'), { directive: 'add', categories: ['web'], request: '' })
  assert.deepEqual(parseReaInput('ADD web, wasm'), { directive: 'add', categories: ['web', 'wasm'], request: '' })
})

test('words that are not categories keep the input a forwarded request', () => {
  assert.deepEqual(parseReaInput('on this binary'), enable('on this binary'))
  assert.deepEqual(parseReaInput('add a test'), enable('add a test'))
  assert.deepEqual(parseReaInput('on the native binary'), enable('on the native binary'))
  assert.deepEqual(parseReaInput('look at this dll'), enable('look at this dll'))
  assert.deepEqual(parseReaInput('add'), enable('add'))
  assert.deepEqual(parseReaInput('add foo'), enable('add foo'))
})

test('a comma list keeps an unknown id so the handler can refuse it', () => {
  assert.deepEqual(parseReaInput('add web,bogus'), { directive: 'add', categories: ['web', 'bogus'], request: '' })
  assert.deepEqual(parseReaInput('on native, nativ'), { directive: 'set', categories: ['native', 'nativ'], request: '' })
  // Prose with a comma is still a request.
  assert.deepEqual(parseReaInput('on this binary, please'), enable('on this binary, please'))
})

test('the known category list is injectable', () => {
  assert.deepEqual(parseReaInput('on foo', ['foo']), { directive: 'set', categories: ['foo'], request: '' })
  assert.deepEqual(parseReaInput('on native', ['foo']), enable('on native'))
})
