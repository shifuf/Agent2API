import test from 'node:test'
import assert from 'node:assert/strict'
import { newId } from './ids.ts'

test('HTTP contexts can create independent IDs without crypto.randomUUID', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      getRandomValues: array => original.get.call(globalThis).getRandomValues(array),
    } })
    const values = Array.from({ length: 64 }, () => newId())
    assert.ok(values.every(value => typeof value === 'string' && value.length >= 16))
    assert.equal(new Set(values).size, values.length)
  } finally {
    Object.defineProperty(globalThis, 'crypto', original)
  }
})

test('environments without Web Crypto can still create nonempty distinct IDs', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
    const a = newId(), b = newId()
    assert.match(a, /^[a-z0-9-]+$/)
    assert.notEqual(a, b)
  } finally {
    Object.defineProperty(globalThis, 'crypto', original)
  }
})
