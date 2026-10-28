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

const PKG = 'dsh-plugin-ssh-console'
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

  /* ------------------------------ what survives a tab switch, and what does not */

  // The file browser is per host and stays mounted. Unmounting it reset the walk
  // to `~` on every tab switch, throwing away the directory the user was reading
  // — the only state here that costs SSH round trips to rebuild.
  const page = bodyOf('SshConsolePage')
  assert.ok(/const filesLayers = sessions\.map/u.test(page), 'one file browser is mounted per host')
  assert.ok(page.includes('filesLayers'), 'the file browsers are rendered')
  assert.ok(!/tab === 'files'\s*\n?\s*\?\s*h\(FilesTab/u.test(page),
    'the file browser is no longer created only for the active tab')
  assert.ok(/visible: tab === 'files' && session\.serverId === activeId/u.test(page),
    'only the selected host\'s file browser is laid out')
  assert.ok(/function FilesTab\(\{ serverId, t, visible \}\)/u.test(clientSource),
    'the file browser takes the visible flag')
  assert.ok(/style: visible \? undefined : \{ display: 'none' \}/u.test(clientSource),
    'a hidden file browser is mounted but not laid out')
  // Navigating away and back must re-read the open directory, not the home one.
  const files = bodyOf('FilesTab')
  assert.ok(/void load\(listedRef\.current\.length > 0 \? listedRef\.current : '~'\)/u.test(files),
    'returning to the tab re-reads the directory already on screen')
  assert.ok(/if \(!visible\) return/u.test(files),
    'the refresh happens on becoming visible, not on every render')
  // Exactly one request per showing. Two effects used to race here: the mount
  // effect read the home directory and the visibility effect read the same one
  // straight after, before the first response could land and set `path`.
  const visibilityEffect = /React\.useEffect\(\(\) => \{\n        if \(!visible\) return[\s\S]*?\n      \}, \[visible\]\)/u.exec(files)
  assert.ok(visibilityEffect !== null, 'one effect owns the loading, keyed on visibility')
  assert.equal((visibilityEffect[0].match(/void load\(/gu) ?? []).length, 2,
    'the effect loads once for the first showing and once for each later one')
  assert.ok(/if \(!loadedRef\.current\) \{/u.test(files),
    'the first showing and every later one take different paths through the effect')
  assert.ok(/listedRef\.current = value\.path/u.test(files),
    'the resolved path is remembered for the next refresh')

  // Overview and processes own no state of their own: they render the snapshot the
  // page holds, so a remount costs no request beyond the poll that resumes.
  for (const name of ['OverviewTab', 'ProcessesTab']) {
    assert.ok(!/useState/u.test(bodyOf(name)), `${name} keeps no private state to lose`)
  }
  // And polling stops while neither of them is on screen.
  assert.ok(/const pollable = tab === 'overview' \|\| tab === 'processes'/u.test(page),
    'sampling is limited to the two tabs that display it')

  // Connecting is a user action only: switching tabs or hosts must never reach it.
  assert.equal((clientSource.match(/call\('connect'/gu) ?? []).length, 1,
    'the only connect call is the connector handler')
  console.log('ok 10 - a tab switch keeps the file browser\'s place and never reconnects')
}

/* ---------------------------------------------------- navigating the file tree */

{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // Lift `buildCrumbs` verbatim and exercise it: the breadcrumb is the whole
  // feature, so the path arithmetic is worth testing rather than asserting on
  // its source text.
  const start = source.indexOf('function buildCrumbs(')
  assert.ok(start > 0, 'the breadcrumb builder exists')
  let depth = 0
  let end = source.indexOf('{', start)
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1
    else if (source[end] === '}') { depth -= 1; if (depth === 0) break }
  }
  const factory = new Function(`${source.slice(start, end + 1)} return buildCrumbs`)
  const buildCrumbs = factory()

  const names = (crumbs) => crumbs.map((crumb) => crumb.name)
  const paths = (crumbs) => crumbs.map((crumb) => crumb.path)

  // The trail spells out the real path from the root, so every prefix level is a
  // target. This is the case the control exists for: on
  // /home/yz/lq/test1/test2/test3 the user wants to click `test1` and land there
  // without walking up three times. Collapsing the home prefix into `~` would
  // hide `/home` and `/yz` and make them unreachable, which is why it is gone.
  const deep = buildCrumbs('/home/yz/lq/test1/test2/test3')
  assert.deepEqual(names(deep), ['/', 'home', 'yz', 'lq', 'test1', 'test2', 'test3'],
    'every level of a deep path gets its own crumb')
  assert.deepEqual(paths(deep), [
    '/', '/home', '/home/yz', '/home/yz/lq',
    '/home/yz/lq/test1', '/home/yz/lq/test1/test2',
    '/home/yz/lq/test1/test2/test3',
  ], 'each crumb carries the absolute path it navigates to')
  // The concrete jump the user asked for.
  const test1 = deep.find((crumb) => crumb.name === 'test1')
  assert.equal(test1.path, '/home/yz/lq/test1', 'clicking test1 navigates to /home/yz/lq/test1')

  // The home directory is shown as its real path, not as `~`; the toolbar button
  // keeps the shorthand for jumping there.
  assert.deepEqual(names(buildCrumbs('/home/yz')), ['/', 'home', 'yz'],
    'the home directory spells itself out')
  assert.deepEqual(names(buildCrumbs('/')), ['/'])
  assert.deepEqual(paths(buildCrumbs('/')), ['/'])

  // Before the first listing resolves, `path` is empty or a bare `~`. Neither
  // must produce a clickable entry pointing at a directory like `/~`.
  assert.deepEqual(names(buildCrumbs('')), ['/'], 'an unresolved path shows the root alone')
  assert.deepEqual(names(buildCrumbs('~')), ['/'], 'a bare tilde shows the root alone')

  // A trailing slash must not produce an empty final crumb.
  assert.deepEqual(names(buildCrumbs('/var/log/')), ['/', 'var', 'log'])

  // Sibling directories are distinct; no prefix of one may be mistaken for
  // another's ancestor.
  assert.deepEqual(paths(buildCrumbs('/home/syz2/data')),
    ['/', '/home', '/home/syz2', '/home/syz2/data'])

  // The bar is an editor as well: the address is a real input, so a deep path
  // can be typed instead of walked. Enter commits, Escape and blur abandon.
  const bar = source.slice(source.indexOf('function FilesTab('), source.indexOf('function TerminalPane('))
  assert.ok(/className: 'ssc-path-input'/u.test(bar), 'the address bar becomes an input while editing')
  assert.ok(/event\.key === 'Enter'/u.test(bar), 'Enter navigates')
  assert.ok(/event\.key === 'Escape'/u.test(bar), 'Escape cancels')
  assert.ok(/onBlur: cancelEdit/u.test(bar), 'clicking away abandons the edit rather than navigating')
  assert.ok(/event\.stopPropagation\(\)/u.test(bar),
    'typing Escape in the box does not leak to a document-level handler')
  assert.ok(/if \(next\.length === 0 \|\| next === path\) return/u.test(bar),
    're-submitting the same path costs no SSH round trip')
  assert.ok(/void load\('~'\)/u.test(bar), 'the home button jumps to the home directory')
  // The breadcrumb no longer needs the home directory: it spells out the real
  // path. Keeping the state around would only invite the collapsing behaviour
  // back, so its absence is asserted rather than its shape.
  assert.ok(!/setHome/u.test(bar), 'the breadcrumb does not depend on a remembered home directory')

  // And every crumb is a button, so a click navigates to that level.
  assert.ok(/crumb\.path === path\) return/u.test(bar), 'clicking the current level is a no-op')
  assert.ok(/void load\(crumb\.path\)/u.test(bar), 'clicking a crumb navigates to it')

  // The new labels exist in both languages.
  for (const key of ['files.home', 'files.edit', 'files.pathHint']) {
    assert.ok(source.includes(`'${key}'`), `${key} is present in both dictionaries`)
  }
  console.log('ok 11 - the address bar accepts a typed path and every breadcrumb level is one click')
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
  console.log('ok 12 - each GPU gauge tracks its own metric and the connector is a dialog')
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
  console.log('ok 13 - the process tables show the full command line')
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

  /* ------------------------------------------- one emulator per pane, ever */

  // `open()` awaits mid-flight, and `termRef.current` is only assigned after that
  // await. Two overlapping calls therefore both passed the old null check and
  // mounted a second emulator into the same holder: the stale one kept its own
  // `onData`, so every keystroke was forwarded twice and the two canvases
  // overlapped in place. That is the corruption seen on the first open of the tab.
  assert.ok(/const openingRef = React\.useRef\(false\)/u.test(pane),
    'the pane guards the in-flight window with a synchronous ref')
  assert.ok(/if \(openingRef\.current\) return/u.test(pane),
    'a second open while one is in flight returns immediately')
  assert.ok(/openingRef\.current = true/u.test(pane), 'the guard is taken before the first await')
  assert.ok(/finally \{\s*openingRef\.current = false\s*\}/u.test(pane),
    'the guard is released on every path, including failure')
  assert.ok(/while \(holder\.firstChild !== null\) holder\.removeChild\(holder\.firstChild\)/u.test(pane),
    'the holder is emptied before mounting, so no stale canvas can survive')

  /* ------------------------- the renderer's own stylesheet must be installed */

  // The regression: `@xterm/xterm` ships `xterm.css` and nothing on the Harness
  // page loads it. Unstyled, `.xterm-screen`/`.xterm-rows` lose their absolute
  // positioning so glyphs overlap into runs like `$$$$$$$$`, and the helper
  // textarea — normally hidden at zero size — becomes a box the user can type
  // into. Every earlier headless probe injected that CSS by hand and so never
  // reproduced it; only rendering the shipped path does.
  assert.ok(/function insertXtermStyles\(css\)/u.test(source), 'the vendored stylesheet has an injector')
  assert.ok(/insertXtermStyles\(vendored\.css\)/u.test(pane),
    'open() installs the stylesheet before mounting the emulator')
  const inject = /function insertXtermStyles\(css\) \{([\s\S]*?)\n    \}/u.exec(source)
  assert.ok(inject !== null, 'insertXtermStyles has a body')
  assert.ok(inject[1].includes('data-dsh-xterm'),
    'a marker attribute makes the sheet findable, so it is installed once')
  assert.ok(/typeof css !== 'string'/u.test(inject[1]), 'a chunk without CSS is tolerated')

  // A fit against a collapsed box must not be believed: `fit()` reports 2x1 for a
  // hidden container, and a PTY told it is two columns wide wraps its prompt and
  // leaves the redraw tail on screen once the real width arrives.
  assert.ok(/function safeFit\(term, fit, holder\)/u.test(source), 'fitting is guarded')
  const safe = /function safeFit\(term, fit, holder\) \{([\s\S]*?)\n    \}/u.exec(source)
  assert.ok(safe !== null, 'safeFit has a body')
  assert.ok(/holder\.clientWidth < 40/u.test(safe[1]), 'a collapsed box is treated as unmeasured')
  assert.ok(/term\.cols < MIN_TERM_COLS/u.test(safe[1]), 'the measured geometry has a floor')
  assert.ok(/FALLBACK_TERM_SIZE/u.test(pane), 'an unmeasurable pane opens at a sane default instead of 2x1')
  assert.ok(/if \(!readyRef\.current\) return/u.test(pane),
    'no resize happens before the first screen is drawn')
  console.log('ok 14 - the renderer stylesheet is installed and a collapsed fit is never believed')

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
  console.log('ok 15 - the terminal opens itself, keeps its session, splits and shows no hint')
}

console.log('\nall client harness checks passed')
