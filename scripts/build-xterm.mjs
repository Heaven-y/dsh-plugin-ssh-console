/**
 * Assemble `client.xterm.js`, the package-local Client chunk that carries the
 * vendored terminal renderer.
 *
 * The Harness page loaders load a package's Client half as a classic script that
 * calls `window.__ModuleLoader__.load({ id, chunk, factory })`, and a sibling
 * chunk may carry the popular terminal library without touching the module
 * table: `require.async('./client.xterm.js')` resolves it relative to this
 * package. All three libraries below are MIT-licensed and are reproduced
 * verbatim; see THIRD-PARTY-NOTICES.
 *
 * Run: node scripts/build-xterm.mjs
 * Reads the installed `@xterm/xterm`, `@xterm/addon-fit` and
 * `@xterm/addon-search` UMD bundles, so those three packages must be installed
 * before regenerating.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PKG_NAME = 'dsh-plugin-ssh-console'
const CHUNK = 'client.xterm.js'

/**
 * Read one UMD bundle and strip its trailing source-map comment, which would
 * otherwise swallow the next line when the bundle is embedded.
 * @param path - absolute file path.
 * @returns the UMD source.
 */
function readUmd(path) {
  return readFileSync(path, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*\s*$/u, '\n')
}

const xtermRoot = join(import.meta.dirname, '..', 'node_modules', '@xterm')
const xterm = readUmd(join(xtermRoot, 'xterm', 'lib', 'xterm.js'))
const fit = readUmd(join(xtermRoot, 'addon-fit', 'lib', 'addon-fit.js'))
const search = readUmd(join(xtermRoot, 'addon-search', 'lib', 'addon-search.js'))
const css = readFileSync(join(xtermRoot, 'xterm', 'css', 'xterm.css'), 'utf8')

for (const [name, source] of [['xterm', xterm], ['addon-fit', fit], ['addon-search', search]]) {
  if (!source.includes('module.exports')) {
    throw new Error(`${name}: expected a UMD bundle assigning module.exports`)
  }
}

const output = `/**
 * Vendored terminal renderer for the SSH Console panel.
 *
 * GENERATED FILE - do not edit. Regenerate with \`node scripts/build-xterm.mjs\`.
 *
 * Contains:
 *   - @xterm/xterm (MIT) - the terminal emulator
 *   - @xterm/addon-fit (MIT) - sizes the emulator to its container
 *   - @xterm/addon-search (MIT) - searches the scrollback
 *
 * All three are reproduced verbatim from their published UMD bundles. Each is run
 * against its own \`module\`/\`exports\` pair so they do not overwrite each other,
 * and the documented wrapper keeps them out of the page's module table.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PKG_NAME)},
  chunk: ${JSON.stringify(CHUNK)},
  factory: () => {
    // ---- @xterm/xterm ------------------------------------------------------
    const xtermModule = { exports: {} }
    ;(function (module, exports) {
${xterm}
    })(xtermModule, xtermModule.exports)

    // ---- @xterm/addon-fit --------------------------------------------------
    const fitModule = { exports: {} }
    ;(function (module, exports) {
${fit}
    })(fitModule, fitModule.exports)

    // ---- @xterm/addon-search -----------------------------------------------
    const searchModule = { exports: {} }
    ;(function (module, exports) {
${search}
    })(searchModule, searchModule.exports)

    return {
      Terminal: xtermModule.exports.Terminal,
      FitAddon: fitModule.exports.FitAddon,
      SearchAddon: searchModule.exports.SearchAddon,
      css: ${JSON.stringify(css)},
    }
  },
})
`

writeFileSync(join(import.meta.dirname, '..', CHUNK), output, 'utf8')
console.log(`${CHUNK}: ${(Buffer.byteLength(output) / 1024).toFixed(0)} KiB`)
