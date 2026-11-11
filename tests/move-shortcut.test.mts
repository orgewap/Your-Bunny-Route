import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldCaptureMoveTab, canBeginObjectMove } from '../src/lib/moveShortcut.ts'

const base = {
  selected: true,
  tool: 'select',
  pointerInsideMap: true,
  textEntry: false,
  otherModifier: false,
}

test('holding Tab over selected map object captures focus change', () => {
  assert.equal(shouldCaptureMoveTab('Tab', base), true)
  assert.equal(canBeginObjectMove(false, true), true)
})
test('Tab remains browser navigation outside the map or when typing', () => {
  assert.equal(shouldCaptureMoveTab('Tab', { ...base, pointerInsideMap: false }), false)
  assert.equal(shouldCaptureMoveTab('Tab', { ...base, textEntry: true }), false)
  assert.equal(shouldCaptureMoveTab('Tab', { ...base, selected: false }), true) // Tab + click selects a road directly
  assert.equal(shouldCaptureMoveTab('Tab', { ...base, tool: 'pen' }), false)
  assert.equal(shouldCaptureMoveTab('Tab', { ...base, otherModifier: true }), false)
  assert.equal(shouldCaptureMoveTab('A', base), false)
})
test('plain selected road click cannot move whole object; persistent move mode still works', () => {
  assert.equal(canBeginObjectMove(false, false), false)
  assert.equal(canBeginObjectMove(true, false), true)
  assert.equal(canBeginObjectMove(true, true), true)
})
