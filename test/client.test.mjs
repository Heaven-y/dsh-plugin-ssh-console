/**
 * Client-half harness: loads the real `client.js` through a stub module loader so
 * the factory, the Remote descriptors and both slot registrations can be checked
 * without a browser.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* ------------------------------------------------------------------ stubs */

/** Minimal chainable zod stand-in: every schema records nothing, parses loosely. */
const zodStub = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined
    return (...args) => {
      const schema = { __call: prop, __args: args }
      schema.optional = () => schema
      schema.describe = () => schema
      schema.readonly = () => schema
      schema.parse = (value) => value
      return schema
    }
  },
})

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial ?? null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: 'Fragment',
}

const styles = []
const documentStub = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (node) => styles.push(node) },
  activeElement: null,
}

let registered
globalThis.window = {
  __ModuleLoader__: {
    load: (record) => {
      registered = record
    },
  },
}
globalThis.document = documentStub

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', 'document', source)(globalThis.window, documentStub)

const PKG = '@coder02lq/dsh-plugin-ssh-console'
assert.equal(registered.id, PKG, 'the factory registers under the package name')

const exportsObject = registered.factory((specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'zod') return zodStub
  throw new Error(`unexpected require: ${specifier}`)
})
assert.deepEqual(Object.keys(exportsObject).filter((key) => key !== 'requireAsync').sort(), ['apply', 'inject'])
assert.deepEqual(exportsObject.inject, ['slots', 'locale', 'remote'])
console.log('ok 1 - factory materializes and exports apply + inject')

/* -------------------------------------------------------- vendored chunk */

{
  let chunk
  globalThis.window.__ModuleLoader__.load = (record) => {
    chunk = record
  }
  const chunkSource = readFileSync(new URL('../client.xterm.js', import.meta.url), 'utf8')
  new Function('window', chunkSource)(globalThis.window)
  globalThis.window.__ModuleLoader__.load = (record) => {
    registered = record
  }
  assert.ok(chunk !== undefined, 'the vendored chunk registers itself')
  assert.equal(chunk.id, PKG, 'the chunk is owned by this package')
  assert.equal(chunk.chunk, 'client.xterm.js', 'the chunk name matches the require.async target')
  assert.match(chunk.chunk, /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/, 'the name satisfies the loader chunk rule')
  const face = chunk.factory(() => {
    throw new Error('the vendored chunk must not require anything')
  })
  assert.equal(typeof face.Terminal, 'function', 'the chunk exposes Terminal')
  assert.equal(typeof face.FitAddon, 'function', 'the chunk exposes FitAddon')
  assert.ok(face.css.includes('.xterm'), 'the chunk carries the terminal stylesheet')
  console.log('ok 2 - the vendored terminal chunk registers and exposes its face')
}

/* ------------------------------------------------------------------ apply */

const mounts = []
const registrations = []
const effects = []
const dictionaries = []
const injected = []

const namespace = {}
const carrier = {
  async $mount(contribution) {
    mounts.push(contribution)
    return async () => {}
  },
}
carrier.sshConsole = namespace

const locale = {
  register: (ns, dicts) => {
    dictionaries.push({ ns, dicts })
    return () => {}
  },
  getLocale: () => ({ id: 'zh-CN' }),
}

const ctx = {
  get: (name) => {
    if (name === 'remote') return carrier
    return undefined
  },
  inject: (deps, callback) => {
    injected.push(deps)
    // The gateway publishes the namespace as `remote.<namespace>`; mirror that.
    callback({ remote: { sshConsole: namespace }, effect: () => () => {} })
    return { dispose: () => {} }
  },
  effect: (callback, label) => {
    const dispose = callback()
    effects.push({ label, dispose })
    return () => {}
  },
  locale,
  slots: {
    inject: (key, callback) => {
      const produced = callback()
      if (produced !== undefined && typeof produced[Symbol.iterator] === 'function') {
        for (const item of produced) registrations.push(item)
      }
      return () => {}
    },
    register: (options, component) => ({ kind: 'registration', options, component }),
  },
}

await exportsObject.apply(ctx)

/* ----------------------------------------------------------- remote mount */

const contribution = mounts[0]
assert.equal(mounts.length, 1, 'one contribution is mounted')
assert.equal(contribution.package, PKG)
const methods = contribution.descriptors.map((descriptor) => descriptor.method)
assert.deepEqual(methods, [
  'servers', 'connect', 'disconnect', 'status', 'listDir', 'readText', 'metrics', 'exec',
  'termOpen', 'termList', 'termRead', 'termWrite', 'termResize', 'termClose',
])
for (const descriptor of contribution.descriptors) {
  assert.equal(descriptor.service, 'sshConsole')
  assert.equal(descriptor.namespace, 'sshConsole')
  assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  assert.equal(descriptor.parameters.length, 1)
  assert.equal(descriptor.parameters[0].name, 'input')
  assert.equal(descriptor.parameters[0].source, 'json')
  assert.equal(descriptor.parameters[0].codec.mode, 'strict')
  assert.equal(descriptor.result.mode, 'strict')
  assert.equal(descriptor.id, `${PKG}#${descriptor.method}`)
}
const ids = contribution.descriptors.map((descriptor) => descriptor.id)
assert.equal(new Set(ids).size, ids.length, 'every endpoint id is unique')
assert.deepEqual(injected, [['remote.sshConsole']], 'the namespace is bound through ctx.inject, not ctx.get')
console.log('ok 3 - fourteen Remote descriptors match the Host SRC signature')

/* ------------------------------------------------------------------ slots */

const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(panel, 'the sidebar icon is registered')
assert.equal(panel.options.id, 'ssh-console')
assert.equal(panel.options.order, 20)
assert.equal(panel.options.locale, 'ssh-console')
assert.equal(typeof panel.options.label, 'function')
assert.ok(panel.options.label().length > 0, 'the panel label is non-empty')
assert.equal(typeof panel.component, 'function')

const page = registrations.find((entry) => entry.options.name === 'main')
assert.ok(page, 'the main panel body is registered')
assert.equal(page.options.key, 'ssh-console', 'the panel key matches the sidebar id')
assert.equal(page.options.locale, 'ssh-console')
assert.equal(typeof page.component, 'function')
assert.equal(page.component.length >= 1, true)
console.log('ok 4 - sidebar icon and main panel are registered under one id')

/* --------------------------------------------------------------- locale */

assert.equal(dictionaries.length, 1)
assert.equal(dictionaries[0].ns, 'ssh-console')
assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
const required = [
  'panel.title', 'empty.title', 'connect.title', 'connect.action', 'connect.disconnect',
  'connect.server', 'connect.password', 'connect.add', 'state.connected', 'state.idle',
  'tab.overview', 'tab.processes', 'tab.files', 'tab.terminal',
  'cpu', 'memory', 'load', 'disk', 'gpu', 'processes', 'gpu.util', 'gpu.memory',
  'col.pid', 'col.user', 'col.cpu', 'col.mem', 'col.rss', 'col.threads', 'col.elapsed', 'col.command',
  'files.up', 'files.refresh', 'files.loading',
  'terminal.title', 'terminal.close', 'terminal.exited', 'terminal.opening', 'terminal.cols',
  'poll.failed', 'since',
]
for (const localeId of ['zh', 'en']) {
  for (const key of required) {
    const value = dictionaries[0].dicts[localeId][key]
    assert.equal(typeof value, 'string', `${localeId}.${key} is present`)
    assert.ok(value.length > 0, `${localeId}.${key} is non-empty`)
  }
}
assert.deepEqual(
  Object.keys(dictionaries[0].dicts.zh).sort(),
  Object.keys(dictionaries[0].dicts.en).sort(),
  'both dictionaries carry the same keys',
)
console.log('ok 5 - zh and en dictionaries are complete and symmetric')

/* -------------------------------------------------------------- styling */

assert.ok(effects.length >= 3, 'remote, stylesheet and dictionaries are owned effects')
assert.equal(styles.length, 1, 'one stylesheet is inserted')
const css = styles[0].textContent
assert.ok(css.includes('.ssc-page'), 'the stylesheet carries the page rules')
assert.ok(css.includes('.ssc-gpu'), 'the stylesheet carries the GPU card rules')
assert.ok(css.includes('.ssc-term-host'), 'the stylesheet carries the terminal rules')
assert.ok(css.includes('.ssc-table-wide'), 'the stylesheet carries the wide process table rules')
const literals = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
assert.deepEqual(literals, [], 'the stylesheet uses theme tokens, not literal colors')
assert.ok(css.includes('var(--dsw-alias-brand-primary)'), 'the accent comes from a token')
console.log('ok 6 - stylesheet inserted once, theme tokens only')

/* ------------------------------------- descriptor vs Host method signature */

/**
 * Mirror the gateway's `srcParameters()`: read the Host method's declared
 * parameter names straight off the prototype source. This is the check whose
 * absence let a zero-argument `servers()` meet a one-field descriptor and fail
 * with `args fields do not match the descriptor: unexpected "input"`.
 */
{
  const { SshConsoleService } = await import('../index.js')
  for (const descriptor of contribution.descriptors) {
    const implementation = SshConsoleService.prototype[descriptor.method]
    assert.equal(typeof implementation, 'function', `${descriptor.method} exists on the Host service`)
    const source = Function.prototype.toString.call(implementation)
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    const body = source.slice(open + 1, close).trim()
    const declared = body.length === 0 ? [] : body.split(',').map((part) => part.trim())
    const wires = descriptor.parameters.map((parameter) => parameter.wire)
    assert.deepEqual(
      wires,
      declared,
      `${descriptor.method}: descriptor wires must equal the Host parameter names`,
    )
  }
  console.log('ok 7 - every descriptor matches its Host method signature exactly')
}

/* --------------------------------------------------- a missing carrier */

{
  const bare = { ...ctx, get: () => undefined }
  await assert.rejects(
    () => exportsObject.apply(bare),
    /Remote carrier service is unavailable/,
    'a profile without the carrier fails loudly instead of half-mounting',
  )
  console.log('ok 8 - a missing Remote carrier is refused')
}

/* ------------------------------------------------- one host per view tab */

{
  // The panel shows one server at a time; the chip strip is what switches. A
  // view tab that iterates the session list would stack hosts again, so the two
  // per-host bodies must not mention `sessions` at all.
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const bodyOf = (name) => {
    const start = clientSource.indexOf(`function ${name}(`)
    assert.ok(start > 0, `${name} exists`)
    const end = clientSource.indexOf('\n    }', start)
    assert.ok(end > start, `${name} has a body`)
    return clientSource.slice(start, end)
  }
  for (const name of ['OverviewTab', 'ProcessesTab']) {
    const body = bodyOf(name)
    assert.ok(!/\bsessions\b/u.test(body), `${name} renders one host, not the session list`)
    assert.ok(/\bsession\b/u.test(body), `${name} takes the selected session`)
  }
  console.log('ok 9 - the overview and process tabs render only the selected host')
}

/* --------------------------------------------------- gauges and the dialog */

{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const bodyOf = (name) => {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start > 0, `${name} exists`)
    const end = source.indexOf('\n    }', start)
    assert.ok(end > start, `${name} has a body`)
    return source.slice(start, end)
  }

  // A GPU card carries two gauges: one under the utilization figure and one
  // under the memory figure. With a single bar between the two rows, a card at
  // 100% utilization and 68% memory reads as a full memory gauge.
  const gpu = bodyOf('GpuCard')
  const bars = gpu.match(/className: 'ssc-bar'/gu) ?? []
  assert.equal(bars.length, 2, 'a GPU card draws one bar per metric, not one shared bar')
  const widths = [...gpu.matchAll(/width: `\$\{clamp\(([^)]+)\)\}%`/gu)].map((match) => match[1].trim())
  assert.deepEqual(widths, ['device.utilization', 'memoryPercent'], 'each bar tracks its own metric')

  // The connection form is a dialog over the panel, not a row that pushes the
  // tabs down while it is open.
  assert.ok(bodyOf('Modal').includes('ssc-scrim'), 'the connector renders as a modal')
  assert.ok(!source.includes('ssc-connector-row'), 'the inline connector row is gone')
  const page = bodyOf('SshConsolePage')
  assert.ok(page.includes('connectorDialog'), 'the page renders the dialog')
  assert.ok(!page.includes('ssc-connector-row'), 'the connector no longer inlines above the tabs')
  console.log('ok 10 - each GPU gauge tracks its own metric and the connector is a dialog')
}

/* ------------------------------------------------- full command, never cut */

{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const bodyOf = (name) => {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start > 0, `${name} exists`)
    const end = source.indexOf('\n    }', start)
    assert.ok(end > start, `${name} has a body`)
    return source.slice(start, end)
  }

  // The GPU process table used to run every command through a helper that kept
  // the last 63 characters. A 224-character training run therefore lost its
  // interpreter and script, leaving only flags. The whole line is the point.
  for (const name of ['GpuProcessTable', 'ProcessTable']) {
    const body = bodyOf(name)
    assert.ok(!body.includes('shortenCommand'), `${name} shows the command in full`)
    assert.ok(/ssc-cmd/u.test(body), `${name} marks the command cell so it can wrap`)
    assert.ok(/process\.command/u.test(body), `${name} renders the raw command`)
  }
  assert.ok(!/function shortenCommand/u.test(source), 'the truncating helper is gone')

  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('/* files */'))
  assert.ok(/td\.ssc-cmd\{[^}]*white-space:normal/u.test(css), 'the command cell wraps instead of clipping')
  assert.ok(/td\.ssc-cmd\{[^}]*overflow-wrap:anywhere/u.test(css), 'a long path can break mid-token')
  assert.ok(!/ssc-table-wide\{min-width:8\d\dpx\}/u.test(css), 'the table no longer forces an 860px floor')
  console.log('ok 11 - the process tables show the full command line')
}

/* ------------------------------------------------------- terminal lifecycle */

{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const bodyOf = (name) => {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start > 0, `${name} exists`)
    const end = source.indexOf('\n    }', start)
    assert.ok(end > start, `${name} has a body`)
    return source.slice(start, end)
  }
  const term = bodyOf('TerminalTab')
  const pane = bodyOf('TerminalPane')

  // Opening the tab is the whole gesture: the tab adopts what the Host holds or
  // opens one, and each pane attaches itself once it is laid out.
  assert.ok(term.includes("call('termList'"), 'the tab adopts the terminals the Host still holds')
  assert.ok(/if \(!visible \|\| phase !== 'closed'\) return/u.test(pane),
    'a pane opens its terminal when it becomes visible')
  assert.ok(!source.includes("t('terminal.open')"), 'no manual open button is offered')

  // The hint paragraph the panel used to show is gone from every dictionary.
  assert.ok(!source.includes('terminal.hint'), 'the explanatory hint is gone')
  const dicts = dictionaries[0].dicts
  for (const localeId of ['zh', 'en']) {
    assert.equal(dicts[localeId]['terminal.hint'], undefined, `${localeId} carries no hint string`)
  }

  // Leaving the tab must not kill the session: the teardown effect disposes the
  // renderer only, and termClose is reached from the close handlers alone.
  const cleanup = pane.slice(pane.indexOf('Unmounting the panel'))
  assert.ok(cleanup.length > 0, 'the unmount effect is commented as a detach')
  const unmountEffect = cleanup.slice(0, cleanup.indexOf('}, [termId])'))
  assert.ok(!unmountEffect.includes('termClose'), 'unmounting does not close the remote PTY')
  assert.ok(!term.includes('termClose') || term.includes('closeTerm'),
    'the tab closes a terminal only through its explicit handler')

  // One mounted terminal per connected host, so switching host or tab keeps the
  // scrollback instead of rebuilding it.
  const page = bodyOf('SshConsolePage')
  assert.ok(/sessions\.map\(\(session\) => \{/u.test(page), 'the page maps hosts to terminals')
  assert.ok(page.includes("visible: tab === 'terminal' && session.serverId === activeId"),
    'exactly one host terminal tab is on screen at a time')
  assert.ok(term.includes("display: 'none'"), 'terminals that are not laid out are skipped')

  /* ------------------------------------------------ multiple panes per host */

  // A server keeps several terminals and shows one or two of them.
  assert.ok(/const \[termIds, setTermIds\]/u.test(term), 'the tab tracks every terminal on the host')
  assert.ok(/const \[panes, setPanes\]/u.test(term), 'the tab tracks which terminals are laid out')
  assert.ok(term.includes("call('termOpen'"), 'a new terminal is opened on demand')
  assert.ok(/if \(panes\.length > 1\) return/u.test(term), 'splitting twice does not create a third pane')
  assert.ok(term.includes('ssc-term-row') || term.includes('ssc-term-${orientation}'),
    'the layout honours the chosen orientation')
  assert.ok(term.includes("split('row')") && term.includes("split('column')"),
    'both split directions are offered')
  assert.ok(term.includes('unsplit'), 'a split can be undone without closing the terminal')

  // The cap mirrors the Host's, so the button cannot fail with a server error.
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(/const MAX_TERMINALS_PER_SERVER = \d+/u.test(host), 'the Host bounds terminals per server')
  assert.ok(host.includes('ssh/too-many-terminals'), 'exceeding the bound is a marked failure')

  // A terminal that is not on screen is still mounted, so its scrollback and its
  // PTY survive being swapped out of a pane.
  assert.ok(/style: onScreen \? undefined : \{ display: 'none' \}/u.test(term),
    'terminals outside the layout stay mounted but hidden')

  /* ------------------------------------------ closing one keeps the other */

  // The regression: closing one of two dropped its id from both lists, leaving an
  // empty pane list. The survivor was still mounted but had no pane, so it was
  // hidden — indistinguishable from "both got closed".
  assert.ok(/const live = panes\.filter\(\(id\) => termIds\.includes\(id\)\)/u.test(term),
    'the layout intersects the pane list with the live terminals')
  assert.ok(/const shown = live\.length > 0 \|\| termIds\.length === 0 \? live : \[termIds\[0\]\]/u.test(term),
    'a surviving terminal is laid out even when no pane holds it')
  const close = /const closeTerm = React\.useCallback\(async \(termId\) => \{([\s\S]*?)\n      \}, \[serverId\]\)/u.exec(term)
  assert.ok(close !== null, 'closeTerm exists')
  assert.ok(/setTermIds\(\(current\) => current\.filter\(\(id\) => id !== termId\)\)/u.test(close[1]),
    'closing removes the terminal id')
  assert.ok(/setPanes\(\(shown\) => shown\.filter\(\(id\) => id !== termId\)\)/u.test(close[1]),
    'closing removes the pane id')
  assert.ok(!/setTermIds\(\(current\) => \{[\s\S]*?setPanes/u.test(close[1]),
    'one state update does not nest inside the other')
  console.log('ok 12 - the terminal opens itself, keeps its session, splits and shows no hint')
}

console.log('\nall client harness checks passed')
