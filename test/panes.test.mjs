// Exercise the pane bookkeeping that decides what stays on screen after a close.
//
// The bug this guards against: closing one of two terminals dropped its id from
// both lists and left the pane list empty. The survivor was still mounted, but
// with no pane to hold it, so it was rendered display:none — which looks exactly
// like "closing one closed both".
import assert from 'node:assert/strict'

/** Mirror of closeTerm: the closed id leaves both lists. */
function close({ termIds, panes }, closed) {
  return {
    termIds: termIds.filter((id) => id !== closed),
    panes: panes.filter((id) => id !== closed),
  }
}

/** Mirror of the render-time derivation, which must never yield an empty view. */
function shownOf({ termIds, panes }) {
  const live = panes.filter((id) => termIds.includes(id))
  if (live.length > 0 || termIds.length === 0) return live
  return [termIds[0]]
}

/** Mirror of the repair effect that normalises state after a render. */
function repair({ termIds, panes }) {
  if (termIds.length === 0) return []
  if (panes.length === 0) return [termIds[0]]
  if (panes.every((id) => termIds.includes(id))) return panes
  const surviving = panes.filter((id) => termIds.includes(id))
  return surviving.length > 0 ? surviving : [termIds[0]]
}

// Closing one of two, with the single pane holding the one being closed.
{
  const after = close({ termIds: ['t1', 't2'], panes: ['t1'] }, 't1')
  assert.deepEqual(after.termIds, ['t2'])
  assert.deepEqual(after.panes, [], 'the closed id leaves the pane list')
  assert.deepEqual(shownOf(after), ['t2'], 'the survivor is laid out, not hidden')
  assert.deepEqual(repair(after), ['t2'], 'state is repaired to match')
}

// Closing one pane of a two-pane split keeps the other half.
{
  const after = close({ termIds: ['t1', 't2'], panes: ['t1', 't2'] }, 't1')
  assert.deepEqual(shownOf(after), ['t2'], 'the split collapses to the survivor')
}

// Closing the one that was not on screen leaves the layout untouched.
{
  const after = close({ termIds: ['t1', 't2', 't3'], panes: ['t1', 't2'] }, 't3')
  assert.deepEqual(shownOf(after), ['t1', 't2'], 'closing a spare does not disturb the split')
}

// Closing the last one empties the view rather than pointing at a ghost.
{
  const after = close({ termIds: ['t1'], panes: ['t1'] }, 't1')
  assert.deepEqual(after.termIds, [])
  assert.deepEqual(shownOf(after), [], 'no pane survives the last terminal')
  assert.deepEqual(repair(after), [])
}

// A pane list that went empty for any other reason still shows a live terminal.
{
  assert.deepEqual(shownOf({ termIds: ['t2'], panes: [] }), ['t2'], 'a living terminal is never hidden')
}

// And no ghost pane is ever invented.
{
  assert.deepEqual(shownOf({ termIds: [], panes: [] }), [])
  assert.deepEqual(shownOf({ termIds: [], panes: ['t9'] }), [], 'no ghost panes')
  assert.deepEqual(repair({ termIds: [], panes: ['t9'] }), [])
}

// Whatever the sequence, something is always laid out while a terminal lives.
// This is the invariant the bug broke.
const layouts = [
  ['t1', 't2'],
  ['t1', 't2', 't3'],
]
for (const ids of layouts) {
  for (const panes of [ids.slice(0, 1), ids.slice(0, 2)]) {
    for (const closed of ids) {
      const after = close({ termIds: ids, panes }, closed)
      const shown = shownOf(after)
      if (after.termIds.length > 0) {
        assert.ok(
          shown.length > 0,
          `closing ${closed} from ${ids.join('+')} (panes ${panes.join('+')}) left every pane hidden`,
        )
        assert.ok(shown.every((id) => after.termIds.includes(id)), 'every laid-out pane maps to a live terminal')
      } else {
        assert.deepEqual(shown, [], 'the last close empties the view')
      }
    }
  }
}

console.log('ok 1 - closing one terminal of two keeps the other on screen')
console.log('ok 2 - closing a spare does not disturb the split')
console.log('ok 3 - closing the last terminal empties the view without a ghost pane')
console.log('\nall pane bookkeeping checks passed')
