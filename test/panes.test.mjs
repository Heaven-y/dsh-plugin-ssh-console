// Exercise the pane bookkeeping that decides what stays on screen after a close.
//
// The bug this guards against: closing one of two terminals dropped its id from
// both lists and left the pane list empty. The survivor was still mounted, but
// with no pane to hold it, so it was rendered display:none — which looks exactly
// like "closing one closed both".
//
// The functions under test are lifted out of client.js and run here, not mirrored.
// A mirror is worse than no test: an earlier version of this file reimplemented
// `repair` and `shown`, so it passed happily while the real repair effect was
// deleted from the component. Lifting the shipped source means the assertions move
// when the code moves.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Lift a top-level `function name(...) { ... }` out of the shipped source.
 * @param name - the function to lift.
 * @returns the function itself.
 */
function lift(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} exists in client.js`)
  let depth = 0
  let end = source.indexOf('{', start)
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1
    else if (source[end] === '}') { depth -= 1; if (depth === 0) break }
  }
  const body = source.slice(start, end + 1)
  // If this throws, the function grew a dependency and must be lifted differently.
  return new Function(`${body} return ${name}`)()
}

const repairPanes = lift('repairPanes')
const shownPanes = lift('shownPanes')

/** Apply the close action the way the component does, then repair. */
function close({ termIds, panes }, closed) {
  const next = {
    termIds: termIds.filter((id) => id !== closed),
    panes: panes.filter((id) => id !== closed),
  }
  next.panes = repairPanes(next.termIds, next.panes) ?? next.panes
  return next
}

/* ------------------------------------------------------ the four close cases */

// Closing one of two, with the single pane holding the one being closed. This is
// the exact regression: the survivor must still be laid out.
{
  const after = close({ termIds: ['t1', 't2'], panes: ['t1'] }, 't1')
  assert.deepEqual(after.termIds, ['t2'])
  assert.deepEqual(after.panes, ['t2'], 'the survivor takes the freed slot')
  assert.deepEqual(shownPanes(after.termIds, after.panes), ['t2'], 'and it is laid out')
}

// Closing one pane of a two-pane split keeps the other half.
{
  const after = close({ termIds: ['t1', 't2'], panes: ['t1', 't2'] }, 't1')
  assert.deepEqual(shownPanes(after.termIds, after.panes), ['t2'], 'the split collapses to the survivor')
}

// Closing the one that was not on screen leaves the layout untouched.
{
  const after = close({ termIds: ['t1', 't2', 't3'], panes: ['t1', 't2'] }, 't3')
  assert.deepEqual(shownPanes(after.termIds, after.panes), ['t1', 't2'], 'closing a spare does not disturb the split')
}

// Closing the last one empties the view rather than pointing at a ghost.
{
  const after = close({ termIds: ['t1'], panes: ['t1'] }, 't1')
  assert.deepEqual(after.termIds, [])
  assert.deepEqual(after.panes, [])
  assert.deepEqual(shownPanes(after.termIds, after.panes), [], 'no pane survives the last terminal')
}

/* ------------------------------------------------ render-time vs. repair pass */

// A close drops the id from both lists in one commit, so between that commit and
// the repair effect the pane list holds nothing. Rendering that state must still
// put the survivor on screen, or the frame flashes empty.
assert.deepEqual(repairPanes(['t2'], []), ['t2'], 'an empty pane list is repaired to a live terminal')
assert.deepEqual(shownPanes(['t2'], []), ['t2'], 'and even unrepaired, a living terminal is never hidden')
assert.equal(repairPanes(['t1', 't2'], ['t1']), null, 'a correct list is left alone, not rewritten')
assert.equal(repairPanes([], []), null, 'an already-empty view is not rewritten')

// No ghost pane is ever invented.
assert.deepEqual(shownPanes([], []), [], 'an empty host shows nothing')
assert.deepEqual(shownPanes([], ['t9']), [], 'no ghost panes')
assert.deepEqual(repairPanes([], ['t9']), [], 'a pane with no terminal is cleared')

// A pane pointing at a terminal that no longer exists, while other terminals are
// still alive. The pane list is non-empty, so the "no panes" branch does not apply,
// and none of its ids survive — the repair must adopt a live terminal rather than
// return the empty intersection, which would lay out nothing at all.
assert.deepEqual(repairPanes(['a'], ['x']), ['a'], 'a dead pane is replaced by a live terminal')
assert.deepEqual(repairPanes(['a', 'b'], ['x', 'y']), ['a'], 'when every pane is dead, the first live terminal is adopted')

// A pane list that drifted for any other reason is narrowed to the survivors,
// keeping their order rather than reverting to the first terminal.
assert.deepEqual(repairPanes(['a', 'b', 'c'], ['b', 'c']), null, 'an already-valid subset is kept')
assert.deepEqual(repairPanes(['b', 'c'], ['a', 'b']), ['b'], 'only the surviving pane is kept')

/* ------------------------------------------------------------ the invariant */

// Whatever the sequence, something is always laid out while a terminal lives.
// This is what the original bug broke, checked across every close order.
const layouts = [['t1', 't2'], ['t1', 't2', 't3']]
for (const ids of layouts) {
  for (const panes of [ids.slice(0, 1), ids.slice(0, 2)]) {
    for (const closed of ids) {
      const after = close({ termIds: ids, panes }, closed)
      const shown = shownPanes(after.termIds, after.panes)
      if (after.termIds.length > 0) {
        assert.ok(shown.length > 0,
          `closing ${closed} from ${ids.join('+')} (panes ${panes.join('+')}) left every pane hidden`)
        assert.ok(shown.every((id) => after.termIds.includes(id)),
          'every laid-out pane maps to a live terminal')
        // And the effect agrees with the render, so no second frame is needed.
        assert.equal(repairPanes(after.termIds, after.panes), null,
          'after the repair the state is stable, so the effect does not loop')
      } else {
        assert.deepEqual(shown, [], 'the last close empties the view')
      }
    }
  }
}

console.log('ok 1 - closing one terminal of two keeps the other on screen')
console.log('ok 2 - closing a spare does not disturb the split')
console.log('ok 3 - closing the last terminal empties the view without a ghost pane')
console.log('ok 4 - the shipped repair and render rules are what is under test')
console.log('\nall pane bookkeeping checks passed')
