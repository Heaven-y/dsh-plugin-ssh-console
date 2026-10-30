/**
 * SSH Console bundle, Host half.
 *
 * A read-mostly remote-console surface for the Harness Web UI: one saved list of
 * SSH targets, one live connection, and four operations over it — a read-only
 * directory browser, a file preview, an nvitop-style resource sampler, and a
 * command runner.
 *
 * Everything here is a plain Node module. Like every workspace-linked bundle it
 * resolves bare specifiers from its own directory, so `ssh2` is a real dependency
 * of this package rather than a Harness package; the Remote binding and the method
 * marker are assembled structurally, matching what `@deepseek-ai/dsh-typert-protocol`
 * produces for generated code.
 *
 * @module dsh-plugin-ssh-console
 */

import {
  readFileSync, existsSync, statSync, appendFileSync, mkdirSync, writeFileSync, renameSync, rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { Client } from 'ssh2'

/** Prototype key `remoteMethods()` reads for one Service's Remote markers. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Cordis service key; also the wire namespace, like `workspaceController` → `workspace`. */
const SERVICE_KEY = 'sshConsole'
/** Every Remote endpoint this Service publishes. */
const REMOTE_METHODS = Object.freeze([
  'servers',
  'connect',
  'disconnect',
  'status',
  'hostKey',
  'saveServer',
  'removeServer',
  'listDir',
  'readText',
  'metrics',
  'exec',
  'termOpen',
  'termList',
  'termRead',
  'termWrite',
  'termResize',
  'termClose',
])
/** Default cadence the Client is told to poll at, in milliseconds. */
const DEFAULT_REFRESH_MS = 2000
/** Default ceiling for one command run from the console. */
const DEFAULT_EXEC_TIMEOUT_MS = 60000
/** Hard ceiling for `head -c` on a file preview. */
const MAX_PREVIEW_BYTES = 256 * 1024
/** Ceiling for one command's captured output, keeping the tail. */
const MAX_CAPTURED_BYTES = 512 * 1024
/** Entries returned for one directory listing. */
const MAX_DIR_ENTRIES = 400
/**
 * Ceiling for the GPU process list.
 *
 * A busy eight-GPU host with containerised workloads can run a few hundred
 * compute processes, so this is set well above any realistic count: it exists to
 * bound the payload, not to trim the view. Every row survives on this host.
 */
const MAX_GPU_PROCESSES = 512
/** Retained terminal scrollback per session, in bytes. */
const MAX_TERM_SCROLLBACK_BYTES = 512 * 1024
/**
 * Terminals one server may hold at once.
 *
 * Each is a full login with its own scrollback, so this bounds both the remote
 * process count and Host memory. Six is enough for a monitoring shell plus a few
 * working ones, and keeps a runaway loop of "new terminal" from exhausting the
 * connection.
 */
const MAX_TERMINALS_PER_SERVER = 6
/** Fallback identity files, in the order OpenSSH tries them. */
const DEFAULT_IDENTITIES = ['id_ed25519', 'id_rsa', 'id_ecdsa']

/**
 * Separator between a server id and a terminal id in the terminal registry.
 *
 * A control character cannot occur in a host alias or a derived server id, so a
 * plain `startsWith` splits the key without ambiguity.
 */
const TERM_KEY_SEPARATOR = '\u0000'

/**
 * Compose the registry key for one terminal.
 * @param serverId - the server the terminal belongs to.
 * @param termId - the terminal's own id.
 * @returns the map key.
 */
function terminalKey(serverId, termId) {
  return `${serverId}${TERM_KEY_SEPARATOR}${termId}`
}

/**
 * Pick the lowest free `t<n>` id.
 * @param taken - the ids already in use on this server.
 * @returns a fresh id.
 */
function nextTerminalId(taken) {
  const used = new Set(taken)
  for (let index = 1; index <= MAX_TERMINALS_PER_SERVER + 1; index += 1) {
    const candidate = `t${index}`
    if (!used.has(candidate)) return candidate
  }
  return `t${used.size + 1}`
}

/**
 * Build a failure the Gateway forwards verbatim. The Gateway identifies Remote
 * failures structurally (`isDSHRemoteError` + `code`), never by class identity.
 * @param code - stable Remote failure code.
 * @param message - user-facing diagnostic.
 * @param details - structured payload.
 * @returns the marked error.
 */
function remoteFailure(code, message, details = {}) {
  return Object.assign(new Error(message), {
    name: 'SshConsoleError',
    code,
    details,
    isDSHRemoteError: true,
  })
}

/**
 * Quote one value for a POSIX shell.
 * @param value - raw text.
 * @returns the single-quoted form.
 */
function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * Build a shell expression for a remote path, keeping `~` expandable.
 *
 * Quoting `~` would ask the shell for a directory literally named `~`, so the
 * home directory is passed to the shell as `$HOME` instead.
 * @param path - the path as typed by a person.
 * @returns a shell expression evaluating to that path.
 */
function remotePathExpr(path) {
  const text = String(path)
  if (text === '~') return '"$HOME"'
  if (text.startsWith('~/')) return `"$HOME"${shq(text.slice(1))}`
  return shq(text)
}

/**
 * Clamp a number into an interval, falling back when it is not a number.
 * @param value - candidate.
 * @param fallback - value to use when `value` is not finite.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped number.
 */
/**
 * Coerce a value to a clamped number.
 *
 * Numeric strings are accepted, because a value typed into a form or written
 * quoted in YAML arrives as text. Rejecting them and falling back to the default
 * is how a port of 26518 once became 22 on the way to disk: the caller had a
 * perfectly good value, it just was not a JS number yet.
 * @param value - candidate.
 * @param fallback - value to use when `value` is not finite.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped number.
 */
function clampNumber(value, fallback, min, max) {
  let number
  if (typeof value === 'number') number = value
  else if (typeof value === 'string' && value.trim().length > 0) number = Number(value.trim())
  else number = fallback
  if (!Number.isFinite(number)) number = fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Parse a port that came from a form, refusing rather than substituting.
 *
 * `clampNumber` is right for reading a file: a corrupt line should degrade to the
 * default instead of throwing. It is wrong for writing one, where substituting a
 * default silently replaces what the user asked for. This returns undefined for
 * anything that is not a whole number in range, so the caller can refuse.
 * @param value - the raw value, a number or text.
 * @returns the port, or undefined when it is not a usable one.
 */
function parsePortStrict(value) {
  const text = typeof value === 'number'
    ? String(value)
    : (typeof value === 'string' ? value.trim() : '')
  if (text.length === 0) return undefined
  if (!/^\d{1,5}$/u.test(text)) return undefined
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/**
 * Expand a leading `~` and resolve an identity path.
 * @param path - configured path, possibly relative to the home directory.
 * @returns an absolute path.
 */
function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/* ------------------------------------------------------------- ssh config */

/**
 * The directives this plugin reads and writes.
 *
 * Everything else in the file is carried through untouched. That is not
 * politeness: a real config holds directives like `HostKeyAlgorithms +ssh-rsa`
 * that this plugin has no opinion about and whose loss would break a host.
 */
const SSH_KEYS = Object.freeze({
  hostname: 'HostName',
  port: 'Port',
  user: 'User',
  identityfile: 'IdentityFile',
})

/**
 * The `~/.ssh/config` this service reads and writes.
 * @returns its absolute path.
 */
function sshConfigPath() {
  return join(homedir(), '.ssh', 'config')
}

/**
 * Split a file into lines, keeping the trailing newline out of the last line.
 *
 * `'a\nb\n'.split('\n')` is `['a', 'b', '']`: that final empty string is the
 * newline, not a line. Leaving it in makes it part of the last block, so removing
 * that block also removes the file's trailing newline. It is tracked separately
 * and put back on the way out.
 * @param source - the file text.
 * @returns the lines and whether the file ended with a newline.
 */
function splitFileLines(source) {
  const raw = source.replace(/\r\n/gu, '\n').split('\n')
  const trailing = raw.length > 1 && raw[raw.length - 1] === ''
  return { lines: trailing ? raw.slice(0, -1) : raw, trailing }
}

/**
 * Join lines back into file text, restoring the trailing newline.
 * @param parsed - carries the end-of-line style and trailing-newline flag.
 * @param lines - the lines to write.
 * @returns the file text.
 */
function joinFileLines(parsed, lines) {
  return lines.join(parsed.eol) + (parsed.trailing ? parsed.eol : '')
}

/**
 * Split `~/.ssh/config` into blocks, keeping each block's line range.
 *
 * A block is a `Host` line plus the indented directives under it. Lines before the
 * first `Host` form a leading block with no keyword of its own; they are kept so a
 * file starting with a comment survives a round trip.
 * @param text - the file contents.
 * @returns the parsed file: original lines, end-of-line style, blocks, and the
 *   directives that make editing unsafe.
 */
function parseSshConfig(text) {
  const source = typeof text === 'string' ? text : ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const { lines, trailing } = splitFileLines(source)
  const blocks = []
  let hasMatch = false
  let hasInclude = false

  /**
   * Open a block that starts at one line.
   * @param index - the line the block starts at.
   * @param label - the alias, empty for the leading block.
   */
  const open = (index, label) => {
    blocks.push({
      label,
      start: index,
      end: lines.length,
      // Index of the line that declares the alias, or -1 for the leading block.
      hostLine: label.length > 0 ? index : -1,
      /** True for a `Host` line whose patterns are all wildcards, e.g. `Host *`. */
      wildcard: false,
      /** Line index per owned directive, first occurrence wins as `ssh` does. */
      keyLines: {},
      host: undefined,
      port: undefined,
      user: undefined,
      identityFile: undefined,
    })
  }

  open(0, '')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const stripped = line.trim()
    if (stripped.length === 0 || stripped.startsWith('#')) continue
    const match = /^(\w+)(?:\s+(\S.*))?$/u.exec(stripped)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    const value = (match[2] ?? '').trim()
    if (keyword === 'host') {
      // Close the block that was open, then start the new one.
      const previous = blocks[blocks.length - 1]
      previous.end = index
      // A block made only of wildcards carries defaults, not a target to list, but
      // it still has to survive an edit, so it stays in `blocks`.
      const patterns = value.split(/\s+/u)
      const literal = patterns.filter((pattern) => !/[*?!]/u.test(pattern))
      open(index, literal[0] ?? '')
      blocks[blocks.length - 1].wildcard = literal.length === 0
      continue
    }
    if (keyword === 'match') hasMatch = true
    if (keyword === 'include') hasInclude = true
    const block = blocks[blocks.length - 1]
    const owned = SSH_KEYS[keyword]
    if (owned === undefined) continue
    // `ssh` uses the first value it sees for a keyword within a host's scope.
    if (block.keyLines[keyword] !== undefined) continue
    block.keyLines[keyword] = index
    if (keyword === 'hostname') block.host = value
    else if (keyword === 'port') block.port = Number(value)
    else if (keyword === 'user') block.user = value
    else if (keyword === 'identityfile') block.identityFile = value
  }
  return { lines, eol, trailing, blocks, hasMatch, hasInclude }
}

/**
 * List the targets declared in `~/.ssh/config`.
 * @param path - the config file; defaults to OpenSSH's own.
 * @returns the declared hosts, in file order.
 */
function readSshConfigHosts(path = sshConfigPath()) {
  let text
  try {
    if (!existsSync(path)) return []
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const { blocks } = parseSshConfig(text)
  const hosts = []
  for (const block of blocks) {
    if (block.label.length === 0) continue
    const host = block.host ?? block.label
    if (host.length === 0) continue
    const port = clampNumber(block.port, 22, 1, 65535)
    hosts.push({
      id: `${block.user ?? ''}@${host}:${port}`,
      label: block.label,
      host,
      port,
      user: block.user,
      identityFile: block.identityFile,
      source: 'ssh-config',
    })
  }
  return hosts
}

/**
 * Reject an alias that `ssh` would not read as a plain host name.
 *
 * A `Host` line takes a whitespace-separated pattern list, so a space would turn
 * one alias into two patterns; `*`, `?` and `!` are pattern syntax with matching
 * semantics, so a label containing them would silently change what the block
 * applies to. Both are refused rather than escaped.
 * @param value - the raw input.
 * @returns the trimmed alias, or an empty string when it is not usable.
 */
function cleanLabel(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0 || text.length > 100) return ''
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f*?!]/u.test(text)) return ''
  // A value starting with `-` would be read as an option by some tools.
  if (text.startsWith('-')) return ''
  return text
}

/**
 * Reject an identity-file path that cannot be one.
 * @param value - the raw input.
 * @returns the trimmed path, or an empty string when it is not usable.
 */
function cleanIdentityFile(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return ''
  // eslint-disable-next-line no-control-regex
  if (text.length > 1024 || /[\u0000-\u001f\u007f]/u.test(text)) return ''
  return text
}

/**
 * Render one directive line.
 * @param keyword - the lower-case key.
 * @param value - the value to write.
 * @param indent - leading whitespace to reuse.
 * @returns the line.
 */
function directiveLine(keyword, value, indent) {
  return `${indent}${SSH_KEYS[keyword]} ${value}`
}

/**
 * Rewrite one block in place, leaving every other line byte-identical.
 *
 * Lines for directives this plugin owns are replaced where they already exist and
 * appended when they do not; directives it does not own, comments and blank lines
 * are carried over untouched and in their original order. Rewriting the whole
 * block from a parsed model would be shorter code and would quietly delete things
 * like `HostKeyAlgorithms`, so it is deliberately not done that way.
 * @param parsed - the result of `parseSshConfig`.
 * @param block - the block to rewrite.
 * @param fields - the desired values; `undefined` or an empty string removes a key.
 * @param label - the desired alias.
 * @returns the complete new file text.
 */
function rewriteBlock(parsed, block, fields, label) {
  const { lines, eol } = parsed
  const indentOf = (index) => {
    const match = /^(\s*)/u.exec(lines[index] ?? '')
    return match !== null && match[1].length > 0 ? match[1] : '  '
  }
  const original = lines.slice(block.start, block.end)
  const target = [...original]

  /**
   * Set one owned directive in the local copy of the block.
   * @param keyword - the lower-case key.
   * @param value - the value, or an empty string to remove the line.
   */
  const setKey = (keyword, value) => {
    const at = block.keyLines[keyword]
    const offset = at === undefined ? -1 : at - block.start
    if (offset >= 0) {
      if (value.length === 0) target[offset] = undefined
      else target[offset] = directiveLine(keyword, value, indentOf(at))
      return
    }
    if (value.length === 0) return
    // Append after the last directive of the block, keeping it inside the block.
    let insertAt = target.length
    while (insertAt > 1 && (target[insertAt - 1] ?? '').trim().length === 0) insertAt -= 1
    target.splice(insertAt, 0, directiveLine(keyword, value, '  '))
  }

  setKey('hostname', fields.host)
  setKey('port', String(fields.port))
  setKey('user', fields.user ?? '')
  setKey('identityfile', fields.identityFile ?? '')
  if (label.length > 0 && block.hostLine >= 0) {
    const offset = block.hostLine - block.start
    const indent = /^(\s*)/u.exec(target[offset] ?? '')?.[1] ?? ''
    target[offset] = `${indent}Host ${label}`
  }

  const kept = target.filter((line) => line !== undefined)
  return joinFileLines(parsed, [...lines.slice(0, block.start), ...kept, ...lines.slice(block.end)])
}

/**
 * Append a block for a new target.
 * @param parsed - the result of `parseSshConfig`.
 * @param fields - the values to write.
 * @param label - the alias.
 * @returns the complete new file text.
 */
function appendBlock(parsed, fields, label) {
  const body = [`Host ${label}`, `  HostName ${fields.host}`, `  Port ${fields.port}`]
  if (fields.user !== undefined && fields.user.length > 0) body.push(`  User ${fields.user}`)
  if (fields.identityFile !== undefined && fields.identityFile.length > 0) {
    body.push(`  IdentityFile ${fields.identityFile}`)
  }
  // Insert before a defaults block rather than after it.
  //
  // `ssh` uses the FIRST value it finds for a keyword, so a block placed after
  // `Host *` would have any keyword that `Host *` also sets silently overridden by
  // it — the entry would look right in the file and authenticate as somebody else.
  // A wildcard block conventionally sits last precisely because of that rule.
  const defaults = parsed.blocks.find((block) => block.wildcard)
  const insertAt = defaults === undefined ? parsed.lines.length : defaults.start
  const head = parsed.lines.slice(0, insertAt)
  while (head.length > 0 && (head[head.length - 1] ?? '').trim().length === 0) head.pop()
  const tail = parsed.lines.slice(insertAt)
  while (tail.length > 0 && (tail[0] ?? '').trim().length === 0) tail.shift()
  return joinFileLines(parsed, [
    ...head,
    ...(head.length > 0 ? [''] : []),
    ...body,
    ...(tail.length > 0 ? [''] : []),
    ...tail,
  ])
}

/**
 * Remove one block.
 *
 * The blank line that separated it from the next block is already inside the
 * block's line range, so no extra bookkeeping is needed in the middle of a file.
 * Only a block at the very end needs care: the blank lines there belong to the
 * file's tail, not to the block, so they are restored afterwards.
 * @param parsed - the result of `parseSshConfig`.
 * @param block - the block to remove.
 * @returns the complete new file text.
 */
function removeBlock(parsed, block) {
  const all = parsed.lines
  const hadTrailingBlank = all.length > 0 && (all[all.length - 1] ?? '').trim().length === 0
  const head = all.slice(0, block.start)
  const tail = all.slice(block.end)
  if (tail.length === 0) {
    // The block ran to the end of the file; drop the separator above it, then put
    // the file's own trailing blank line back.
    while (head.length > 0 && (head[head.length - 1] ?? '').trim().length === 0) head.pop()
    if (hadTrailingBlank && head.length > 0) head.push('')
  } else if (head.length === 0) {
    while (tail.length > 0 && (tail[0] ?? '').trim().length === 0) tail.shift()
  }
  return joinFileLines(parsed, [...head, ...tail])
}

/* ------------------------------------------------------------ known hosts */

/**
 * The `known_hosts` file OpenSSH would consult.
 * @returns its absolute path.
 */
function knownHostsPath() {
  return join(homedir(), '.ssh', 'known_hosts')
}

/**
 * The name a host key is filed under, in OpenSSH's own spelling.
 *
 * A non-default port is part of the name: OpenSSH writes and looks up
 * `[host]:2222`, and using the bare host for those would silently accept a key
 * learned from a different service on the same machine.
 * @param host - hostname or address.
 * @param port - the port, defaulting to 22.
 * @returns the lookup name.
 */
function knownHostName(host, port) {
  return port === 22 ? host : `[${host}]:${port}`
}

/**
 * Match one `known_hosts` host pattern against a lookup name.
 *
 * Only the subset OpenSSH actually writes is honoured: literal names, `*` and `?`
 * wildcards, and `!` negation handled by the caller's order of evaluation. A
 * hashed entry is an HMAC of the name and is compared separately.
 * @param pattern - the pattern from the file.
 * @param name - the lookup name.
 * @returns whether it matches.
 */
function knownHostPatternMatches(pattern, name) {
  if (pattern === name) return true
  if (!/[*?]/.test(pattern)) return false
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const expression = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  try {
    return new RegExp(`^${expression}$`, 'i').test(name)
  } catch {
    return false
  }
}

/**
 * Split a raw host key into the two fields `known_hosts` stores.
 *
 * The wire format of a public key is a length-prefixed algorithm name followed by
 * the key material, and `known_hosts` keeps the whole blob — length prefix
 * included — as its base64 column. Parsing it here avoids depending on how
 * `ssh2`'s own key parser names things.
 * @param key - the raw host key from the handshake.
 * @returns the algorithm name and the base64 body.
 */
function hostKeyParts(key) {
  const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key)
  if (buffer.length < 4) return { type: '', body: '' }
  const length = buffer.readUInt32BE(0)
  if (length === 0 || length > buffer.length - 4) return { type: '', body: '' }
  return {
    type: buffer.subarray(4, 4 + length).toString('ascii'),
    body: buffer.toString('base64'),
  }
}

/**
 * Test a hashed `known_hosts` entry against a lookup name.
 *
 * The form is `|1|<base64 salt>|<base64 HMAC-SHA1>`, where the HMAC is computed
 * over the name with the salt as its key.
 * @param entry - the hashed host field.
 * @param name - the lookup name.
 * @returns whether it matches.
 */
function knownHostHashedMatches(entry, name) {
  const parts = entry.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  let salt
  try {
    salt = Buffer.from(parts[2], 'base64')
  } catch {
    return false
  }
  const expected = parts[3]
  const actual = createHmac('sha1', salt).update(name).digest('base64')
  return actual === expected
}

/**
 * Read and parse `known_hosts`.
 *
 * Unreadable or absent is not an error: it means nothing is known yet, which is
 * exactly the state a first connection starts from.
 * @param path - the file to read.
 * @returns the usable entries, in file order; unparsable lines are skipped.
 */
function readKnownHosts(path) {
  let text
  try {
    if (!existsSync(path)) return []
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 3) continue
    let marker
    let rest = fields
    if (rest[0].startsWith('@')) {
      marker = rest[0]
      rest = rest.slice(1)
      if (rest.length < 3) continue
    }
    const [hostField, keyType, keyBody] = rest
    entries.push({ marker, hostField, keyType, keyBody })
  }
  return entries
}

/**
 * Decide what a freshly seen host key means.
 *
 * The four outcomes are deliberately distinct, because the safe reaction to each
 * is different: a `mismatch` must never be treated as "not yet trusted".
 *
 * A `known_hosts` file legitimately holds several key types for one host — an
 * older `ssh` may have stored only the ECDSA key while the server now offers
 * Ed25519 first. Only an entry of the *same* type with a different body is a
 * mismatch; a different type simply means this particular key has not been seen
 * before. Treating the two as the same refuses hosts that `ssh` connects to
 * happily, which is how this was first noticed.
 * @param entries - parsed `known_hosts` entries.
 * @param host - the host being connected to.
 * @param port - its port.
 * @param keyType - the algorithm the server offered, e.g. `ssh-ed25519`.
 * @param keyBody - the key body, base64, as it appears in `known_hosts`.
 * @returns `'trusted'`, `'revoked'`, `'mismatch'` or `'unknown'`.
 */
function classifyHostKey(entries, host, port, keyType, keyBody) {
  const name = knownHostName(host, port)
  let conflicting = false
  for (const entry of entries) {
    const matches = entry.hostField.startsWith('|1|')
      ? knownHostHashedMatches(entry.hostField, name)
      : entry.hostField.split(',').some((pattern) => (
        pattern.startsWith('!')
          ? false
          : knownHostPatternMatches(pattern, name)
      ))
    if (!matches) continue
    if (entry.marker === '@revoked') {
      // A revoked key is revoked whether or not it is also listed as valid. This
      // one is per key, not per host, so it still needs the type to match.
      if (entry.keyType === keyType && entry.keyBody === keyBody) return 'revoked'
      continue
    }
    // `@cert-authority` lines hold the CA's key, not this host's.
    if (entry.marker === '@cert-authority') continue
    if (entry.keyType !== keyType) continue
    if (entry.keyBody === keyBody) return 'trusted'
    // Same host, same algorithm, different key: the dangerous case, and the one
    // that must not be confused with "unknown".
    conflicting = true
  }
  return conflicting ? 'mismatch' : 'unknown'
}

/**
 * Render a host key the way `ssh` does: `SHA256:` and base64, no padding.
 * @param key - the raw host key buffer from the handshake.
 * @returns the fingerprint.
 */
function fingerprintSha256(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

/**
 * Record a host key so the next connection is recognised.
 *
 * Appended in OpenSSH's own format, which is what makes the trust decision useful
 * rather than something the user re-confirms on every reconnect.
 * @param path - the `known_hosts` file to append to.
 * @param host - the host.
 * @param port - its port.
 * @param keyType - the algorithm.
 * @param keyBody - the base64 key body.
 * @returns whether the write succeeded.
 */
function appendKnownHost(path, host, port, keyType, keyBody) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${knownHostName(host, port)} ${keyType} ${keyBody}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- sampling */

/**
 * Split a `###SECTION` framed response into its sections.
 * @param text - the remote script's combined output.
 * @returns one array of lines per section name.
 */
function splitSections(text) {
  const sections = new Map()
  let name
  let buffer = []
  const commit = () => {
    if (name === undefined) return
    sections.set(name, buffer)
    buffer = []
  }
  for (const line of String(text).split(/\r?\n/)) {
    const marker = /^###([A-Z]+)\s*$/.exec(line)
    if (marker !== null) {
      commit()
      name = marker[1]
      continue
    }
    if (name !== undefined) buffer.push(line)
  }
  commit()
  return sections
}

/**
 * Read one section as trimmed lines with trailing blanks dropped.
 * @param sections - framed sections.
 * @param name - section name.
 * @returns its lines.
 */
function sectionLines(sections, name) {
  const lines = sections.get(name) ?? []
  const out = []
  for (const line of lines) out.push(line)
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Read the first line of a section.
 * @param sections - framed sections.
 * @param name - section name.
 * @returns the trimmed line, or an empty string.
 */
function sectionLine(sections, name) {
  const lines = sectionLines(sections, name)
  return lines.length > 0 ? lines[0].trim() : ''
}

/**
 * Parse `/proc/stat`'s aggregate CPU line into busy/idle totals.
 * @param line - the `cpu  …` line.
 * @returns totals, or undefined when the line does not match.
 */
function parseCpuStat(line) {
  const fields = String(line).trim().split(/\s+/)
  if (fields[0] !== 'cpu' || fields.length < 8) return undefined
  const numbers = fields.slice(1, 9).map((value) => Number(value))
  if (numbers.some((value) => !Number.isFinite(value))) return undefined
  const [user, nice, system, idle, iowait, irq, softirq, steal] = numbers
  const total = user + nice + system + idle + iowait + irq + softirq + steal
  return { total, idle: idle + iowait }
}

/**
 * Turn two `/proc/stat` samples into a utilization percentage.
 * @param previous - the earlier sample.
 * @param current - the later sample.
 * @returns busy percentage, or undefined without a usable delta.
 */
function cpuPercent(previous, current) {
  if (previous === undefined || current === undefined) return undefined
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (!Number.isFinite(total) || total <= 0) return undefined
  return Math.max(0, Math.min(100, (1 - idle / total) * 100))
}

/**
 * Parse a `nvidia-smi --query-gpu` CSV row.
 *
 * The device name is free text and may itself contain commas, so the layout puts
 * the two fixed fields first and the fixed-width numeric tail last, leaving
 * everything between as the name. `uuid` rides along with the device row rather
 * than being queried separately: it is what joins a compute process to its card,
 * and asking for it in its own `nvidia-smi` cost a second process launch on every
 * poll for a value that never changes.
 * @param line - one CSV row of `index,uuid,name,util,memused,memtotal,temp,power`.
 * @returns the parsed device, or undefined for a line that does not match.
 */
function parseGpuRow(line) {
  const parts = String(line).split(',').map((part) => part.trim())
  if (parts.length < 8) return undefined
  const index = Number(parts[0])
  if (!Number.isFinite(index)) return undefined
  const tail = parts.slice(-5)
  const numeric = (value) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return {
    index,
    uuid: parts[1].length > 0 ? parts[1] : undefined,
    name: parts.slice(2, parts.length - 5).join(', '),
    utilization: numeric(tail[0]),
    memoryUsedMiB: numeric(tail[1]),
    memoryTotalMiB: numeric(tail[2]),
    temperatureC: numeric(tail[3]),
    powerW: numeric(tail[4]),
  }
}

/**
 * Parse one `pid,gpu_uuid,used_memory` row from `--query-compute-apps`.
 * @param line - one CSV row.
 * @returns the row, or undefined when it does not match.
 */
function parseGpuAppRow(line) {
  const parts = String(line).split(',').map((part) => part.trim())
  if (parts.length < 3) return undefined
  const pid = Number(parts[0])
  if (!Number.isFinite(pid)) return undefined
  const usedMiB = Number(parts[parts.length - 1])
  return {
    pid,
    uuid: parts.slice(1, parts.length - 1).join(','),
    usedMiB: Number.isFinite(usedMiB) ? usedMiB : undefined,
  }
}

/**
 * Parse one `pid,user,args` row used to identify GPU processes.
 * @param line - one row, header excluded.
 * @returns the identity, or undefined for a blank line.
 */
function parseGpuAppOwnerRow(line) {
  const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  return { pid: Number(match[1]), user: match[2], command: match[3].trim() }
}

/**
 * Parse one full `ps -eo` row: pid, ppid, user, %cpu, %mem, elapsed, stat,
 * threads, rss(KiB) and the full command line.
 * @param line - one row, header excluded.
 * @returns the process, or undefined for a blank or header line.
 */
function parseProcessRow(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  const rssKib = Number(match[9])
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    user: match[3],
    cpuPercent: Number(match[4]),
    memoryPercent: Number(match[5]),
    elapsed: match[6],
    state: match[7],
    threads: Number(match[8]),
    rssBytes: Number.isFinite(rssKib) ? rssKib * 1024 : 0,
    command: match[10].trim(),
  }
}

/**
 * Parse `/proc/meminfo` lines into a byte-accurate memory summary.
 * @param lines - the `MemTotal:`-style lines.
 * @returns memory in bytes.
 */
function parseMemory(lines) {
  const values = new Map()
  for (const line of lines) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim())
    if (match === null) continue
    values.set(match[1], Number(match[2]) * 1024)
  }
  const total = values.get('MemTotal') ?? 0
  const available = values.get('MemAvailable') ?? values.get('MemFree') ?? 0
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    swapTotalBytes: values.get('SwapTotal') ?? 0,
    swapFreeBytes: values.get('SwapFree') ?? 0,
  }
}

/**
 * Whether a path is already a clean absolute path that needs no resolution.
 *
 * `realpath` is a round trip. Clicking a folder in the browser produces
 * `parent + '/' + name`, which is already absolute and free of `.` and `..`, so
 * asking the server to resolve it costs a trip for an answer the client already
 * has. Only `~`, relative paths and dot segments need it.
 * @param path - the requested path.
 * @returns true when `path` can be used as the resolved form as-is.
 */
function isCleanAbsolute(path) {
  if (!String(path).startsWith('/')) return false
  for (const segment of String(path).split('/')) {
    if (segment === '.' || segment === '..') return false
  }
  return true
}

/**
 * Classify an SFTP directory entry from its `mode` bits.
 *
 * SFTP reports the POSIX mode as a number, so the file-type field is the same
 * `0o170000` mask the shell path read out of `stat -c %f`. Windows SFTP servers
 * often leave `mode` unset, in which case the entry is treated as a file rather
 * than guessed at.
 * @param entry - one `readdir` result.
 * @returns `'directory'`, `'symlink'`, `'file'` or `'other'`.
 */
function sftpKind(entry) {
  const mode = entry?.attrs?.mode
  if (typeof mode !== 'number') {
    // A missing mode is not a directory claim. Longname is the only other hint,
    // and it starts with `d` for a directory on every server that sets it.
    return typeof entry?.longname === 'string' && entry.longname.startsWith('d') ? 'directory' : 'file'
  }
  const typeBits = mode & 0o170000
  if (typeBits === 0o040000) return 'directory'
  if (typeBits === 0o120000) return 'symlink'
  if (typeBits === 0o100000) return 'file'
  return 'other'
}

/**
 * Parse one `mode|size|mtime|path` row produced by `stat -c`.
 * @param line - one row.
 * @returns the entry, or undefined for a line that does not match.
 */
function parseStatRow(line) {
  const first = line.indexOf('|')
  if (first < 0) return undefined
  const second = line.indexOf('|', first + 1)
  if (second < 0) return undefined
  const third = line.indexOf('|', second + 1)
  if (third < 0) return undefined
  const modeText = line.slice(0, first).trim()
  const size = Number(line.slice(first + 1, second))
  const mtime = Number(line.slice(second + 1, third))
  let path = line.slice(third + 1)
  if (path.startsWith('./')) path = path.slice(2)
  const hex = Number.parseInt(modeText, 16)
  const typeBits = Number.isFinite(hex) ? hex & 0o170000 : undefined
  const kind = typeBits === 0o040000
    ? 'directory'
    : typeBits === 0o120000
      ? 'symlink'
      : typeBits === 0o100000
        ? 'file'
        : 'other'
  return {
    name: path,
    kind,
    sizeBytes: Number.isFinite(size) ? size : 0,
    modifiedMs: Number.isFinite(mtime) ? mtime * 1000 : 0,
  }
}

/**
 * Sampling script. Sections are framed by `###NAME` markers on their own line so
 * one round trip carries everything the page shows.
 *
 * The GPU process section resolves each pid's owner and command line as well as
 * its device, because `nvidia-smi` alone reports a bare pid and memory figure.
 */
const METRICS_SCRIPT = [
  'echo "###HOST"',
  'hostname 2>/dev/null',
  'echo "###UNAME"',
  'uname -sr 2>/dev/null',
  'echo "###UPTIME"',
  'cut -d. -f1 /proc/uptime 2>/dev/null',
  'echo "###LOAD"',
  'cat /proc/loadavg 2>/dev/null',
  'echo "###NPROC"',
  'nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo 2>/dev/null',
  'echo "###STAT"',
  'head -1 /proc/stat 2>/dev/null',
  'echo "###MEM"',
  "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
  'echo "###GPU"',
  'if command -v nvidia-smi >/dev/null 2>&1; then '
    + 'nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw '
    + '--format=csv,noheader,nounits 2>/dev/null; else echo NOGPU; fi',
  // The compute process list is captured once and reused: the owner lookup below
  // needs the same pids, and re-querying them was a third `nvidia-smi` launch per
  // poll for a list the previous line had already produced.
  'echo "###GPUAPPS"',
  'gpuapps=$(nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory '
    + '--format=csv,noheader,nounits 2>/dev/null); printf "%s\\n" "$gpuapps"',
  'echo "###GPUAPPOWNERS"',
  'apppids=$(printf "%s\\n" "$gpuapps" | cut -d, -f1 | tr -d " " | sed "/^$/d" | paste -sd, -); '
    + '[ -n "$apppids" ] && ps -o pid=,user=,args= -p "$apppids" 2>/dev/null',
  'echo "###DISK"',
  'df -P -h / 2>/dev/null | tail -n 1',
  'echo "###TOP"',
  'ps -eo pid,ppid,user,pcpu,pmem,etime,stat,nlwp,rss,args --sort=-pcpu 2>/dev/null | head -n 21',
  'echo "###END"',
].join('\n')

/**
 * Where the servers added from the panel are kept.
 * @returns the default path: a file this plugin owns, shared by every profile.
 */
function defaultServersFile() {
  return join(homedir(), '.dsh', 'ssh-console', 'servers.json')
}

/**
 * Reject a host that cannot be a hostname or address.
 *
 * This matters beyond tidiness: the value reaches `ssh2` as the dial target and is
 * written into `known_hosts`, whose format is whitespace-separated. A newline there
 * would inject a line, so control characters and whitespace are refused outright
 * rather than escaped.
 * @param value - the raw input.
 * @returns the trimmed host, or an empty string when it is not usable.
 */
function cleanHost(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0 || text.length > 255) return ''
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f#]/u.test(text)) return ''
  return text
}

/**
 * Reject a user name that cannot be one.
 * @param value - the raw input.
 * @returns the trimmed name, or an empty string when it is not usable.
 */
function cleanUser(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return ''
  // eslint-disable-next-line no-control-regex
  if (text.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(text)) return ''
  return text
}

/**
 * Compose the stable id for a target.
 *
 * The same spelling `~/.ssh/config` discovery uses, so a server added here and the
 * same server discovered there collapse to one entry instead of appearing twice.
 * @param user - the login name, possibly empty.
 * @param host - the host.
 * @param port - the port.
 * @returns the id.
 */
function serverIdFor(user, host, port) {
  return `${user}@${host}:${port}`
}

/**
 * Read the server list this plugin owns.
 *
 * A corrupt file is reported rather than swallowed: returning an empty list would
 * look exactly like "the user has no saved servers" and the next save would
 * overwrite whatever was still recoverable on disk.
 * @param path - the file to read.
 * @returns `{ entries, error }`; `error` is a message when the file exists but
 *   could not be understood.
 */
function readServerStore(path) {
  let text
  try {
    if (!existsSync(path)) return { entries: [], error: undefined }
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { entries: [], error: `cannot read ${path}: ${error.message}` }
  }
  if (text.trim().length === 0) return { entries: [], error: undefined }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], error: `${path} is not valid JSON (${error.message}); it was left untouched` }
  }
  const raw = Array.isArray(parsed?.servers) ? parsed.servers : []
  const entries = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const host = cleanHost(item.host)
    if (host.length === 0) continue
    const port = clampNumber(item.port, 22, 1, 65535)
    const user = cleanUser(item.user)
    entries.push({
      id: serverIdFor(user, host, port),
      label: typeof item.label === 'string' && item.label.trim().length > 0
        ? item.label.trim().slice(0, 100)
        : `${user === '' ? '' : `${user}@`}${host}`,
      host,
      port,
      user,
      identityFile: typeof item.identityFile === 'string' && item.identityFile.length > 0
        ? item.identityFile
        : undefined,
      // Stored only when the user asked for it; see the class docs on `saveServer`.
      password: typeof item.password === 'string' && item.password.length > 0 ? item.password : undefined,
    })
  }
  return { entries, error: undefined }
}

/**
 * Replace the server list on disk.
 *
 * Written to a temporary file and renamed into place so a crash mid-write cannot
 * leave a half-written list, which would read as "no servers" on the next start.
 * The directory is created 0700 and the file 0600: it can hold a password.
 * @param path - the file to write.
 * @param entries - the entries to store.
 * @returns an error message, or undefined on success.
 */
function writeServerStore(path, entries) {
  const payload = JSON.stringify({
    version: 1,
    servers: entries.map((entry) => {
      const record = {
        label: entry.label,
        host: entry.host,
        port: entry.port,
      }
      if (entry.user !== undefined && entry.user.length > 0) record.user = entry.user
      if (entry.identityFile !== undefined) record.identityFile = entry.identityFile
      if (entry.password !== undefined) record.password = entry.password
      return record
    }),
  }, null, 2)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, `${payload}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return undefined
  } catch (error) {
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true })
    } catch {
      // Nothing to clean up.
    }
    return `cannot write ${path}: ${error.message}`
  }
}

/* ------------------------------------------------------------------ service */
/**
 * Socket-level failures that happen before any key exists.
 *
 * A refused connection is not a host-key problem, and reporting it as one sends
 * people looking at known_hosts and fingerprints when nothing is even listening.
 */
const UNREACHABLE_CODES = Object.freeze(new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN',
]))

/**
 * Describe a failed dial as unreachable, or leave the error alone.
 * @param error - the error thrown by ssh2.
 * @param server - the target that was dialled.
 * @returns a coded failure, or undefined when this is not a transport failure.
 */
function unreachableFailure(error, server) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (!UNREACHABLE_CODES.has(code)) return undefined
  return remoteFailure(
    'ssh/unreachable',
    `Could not reach ${server.host}:${server.port} (${code}). Nothing was sent to it.`,
    { serverId: server.id, host: server.host, port: server.port, code },
  )
}

/**
 * One SSH session plus the surfaces the console page reads.
 *
 * The connection is deliberately owned here rather than per call: a console page
 * polls once every couple of seconds, and re-authenticating each time would cost a
 * handshake per sample. Loss of the connection marks the state closed so the page
 * reports it instead of hanging.
 */
class SshConsoleService {
  /**
   * @param ctx - Host context owning this Service.
   * @param config - the Loader row's `config` object, already merged with defaults.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.settings = {
      refreshMs: clampNumber(config?.refreshMs, DEFAULT_REFRESH_MS, 1000, 60000),
      execTimeoutMs: clampNumber(config?.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 2000, 600000),
      includeSshConfig: config?.includeSshConfig !== false,
      servers: Array.isArray(config?.servers) ? config.servers : [],
      // Overridable so a test can point at a scratch file instead of the real one.
      knownHostsFile: typeof config?.knownHostsFile === 'string' && config.knownHostsFile.trim().length > 0
        ? config.knownHostsFile.trim()
        : undefined,
      // Same reason, for the config the panel can edit.
      sshConfigFile: typeof config?.sshConfigFile === 'string' && config.sshConfigFile.trim().length > 0
        ? config.sshConfigFile.trim()
        : undefined,
      // Off means the panel shows the list read-only, which is what a profile that
      // must not touch the user's OpenSSH config would want.
      allowConfigEdit: config?.allowConfigEdit !== false,
    }
    /**
     * Live connections keyed by server id. One page may watch several machines,
     * and each keeps its own CPU baseline for the utilization delta.
     */
    this.sessions = new Map()
    /** Interactive PTYs, keyed by server id. Independent of the SSH connection. */
    this.terminals = new Map()
    /** Binding `readBinding()` validates: service identity, Cordis key, wire namespace. */
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: SERVICE_KEY,
    })
  }

  /**
   * Every configured target: the row's own entries first, then `~/.ssh/config`.
   * @param input - unused; the wire requires one field per declared parameter.
   * @returns the de-duplicated target list plus the polling cadence.
   */
  async servers(input) {
    void input
    const entries = []
    const seen = new Set()
    const push = (entry) => {
      if (seen.has(entry.id)) return
      seen.add(entry.id)
      entries.push(entry)
    }
    for (const raw of this.settings.servers) {
      if (raw === null || typeof raw !== 'object') continue
      const host = typeof raw.host === 'string' ? raw.host.trim() : ''
      if (host.length === 0) continue
      const port = clampNumber(raw.port, 22, 1, 65535)
      const user = typeof raw.user === 'string' ? raw.user.trim() : ''
      push({
        id: `${user}@${host}:${port}`,
        label: typeof raw.label === 'string' && raw.label.trim().length > 0
          ? raw.label.trim()
          : `${user === '' ? '' : `${user}@`}${host}`,
        host,
        port,
        user,
        identityFile: expandHome(raw.identityFile),
        source: 'config',
        // A target declared in this plugin's own config has no file to write back
        // to, so the panel must not offer to edit it.
        editable: false,
      })
    }
    if (this.settings.includeSshConfig) {
      for (const entry of readSshConfigHosts(this.sshConfigFile())) {
        push({ ...entry, identityFile: expandHome(entry.identityFile), editable: this.settings.allowConfigEdit !== false })
      }
    }
    return {
      servers: entries,
      refreshMs: this.settings.refreshMs,
      connectedIds: [...this.sessions.keys()],
      // Where the editable entries live, shown in the panel so a failed write can
      // tell the user exactly which file to open.
      configPath: this.sshConfigFile(),
      // Editing needs a real file on a real disk; the panel hides the controls
      // when it is off, so a remote or sandboxed profile cannot offer a button
      // that would always fail.
      canEdit: this.settings.allowConfigEdit !== false,
    }
  }

  /**
   * The `~/.ssh/config` this service reads and writes.
   * @returns its absolute path.
   */
  sshConfigFile() {
    const configured = expandHome(this.settings.sshConfigFile)
    return configured === undefined ? sshConfigPath() : configured
  }

  /**
   * Read the config file, refusing the operations that cannot be done safely.
   * @returns the raw text and its parse.
   */
  loadSshConfig() {
    const path = this.sshConfigFile()
    let text = ''
    try {
      if (existsSync(path)) text = readFileSync(path, 'utf8')
    } catch (error) {
      throw remoteFailure(
        'ssh/config-unreadable',
        `Cannot read ${path}: ${error.message}. Edit that file by hand.`,
        { path },
      )
    }
    const parsed = parseSshConfig(text)
    if (parsed.hasMatch) {
      throw remoteFailure(
        'ssh/config-unsupported',
        `${path} uses a Match directive. Editing it here is refused because Match changes what the blocks around it mean, and a wrong rewrite would be silent. Edit that file by hand.`,
        { path },
      )
    }
    return { path, text, parsed }
  }

  /**
   * Write a new config file, then prove the result says what was intended.
   *
   * The write goes to a temporary file in the same directory and is renamed into
   * place, so an interrupted write cannot leave a truncated config. Before the
   * rename the new text is parsed again and the target block is checked, which
   * turns a mistake here into a refused write rather than a broken file.
   * @param path - the config file.
   * @param text - the new contents.
   * @param expect - the label and values the file must contain afterwards.
   */
  commitSshConfig(path, text, expect) {
    const temporary = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, text, { mode: 0o600 })
    } catch (error) {
      try {
        if (existsSync(temporary)) rmSync(temporary, { force: true })
      } catch {
        // Nothing to clean up.
      }
      throw remoteFailure(
        'ssh/config-unwritable',
        `Cannot write ${path}: ${error.message}. Edit that file by hand.`,
        { path },
      )
    }
    const check = parseSshConfig(text)
    const written = check.blocks.find((block) => block.label === expect.label)
    const ok = expect.remove === true
      ? written === undefined
      : written !== undefined
        && (written.host ?? written.label) === expect.host
        && clampNumber(written.port, 22, 1, 65535) === expect.port
    if (!ok) {
      try {
        if (existsSync(temporary)) rmSync(temporary, { force: true })
      } catch {
        // Nothing to clean up.
      }
      throw remoteFailure(
        'ssh/config-verify-failed',
        `Refusing to write ${path}: the result would not describe "${expect.label}" as intended. Nothing was changed.`,
        { path, label: expect.label },
      )
    }
    try {
      renameSync(temporary, path)
    } catch (error) {
      throw remoteFailure(
        'ssh/config-unwritable',
        `Cannot replace ${path}: ${error.message}. Edit that file by hand.`,
        { path },
      )
    }
  }

  /**
   * Disconnect a target if it is live, because its parameters just changed.
   *
   * The terminals on it go too: a PTY cannot outlive the connection carrying it,
   * so this is a real consequence of editing, not an oversight.
   * @param label - the alias whose block was just edited or removed.
   * @param previous - the entries as they were read before the write.
   */
  async dropEditedSession(label, previous) {
    const entry = previous.find((candidate) => candidate.label === label)
    if (entry === undefined || !this.sessions.has(entry.id)) return
    await this.disconnect({ serverId: entry.id })
  }

  /**
   * Add a target to `~/.ssh/config`, or update the one already there.
   *
   * Editing is surgical: only the lines belonging to the directives this plugin
   * owns are rewritten, so comments, `Host *` defaults and directives it does not
   * understand survive untouched. A live connection to the edited target is
   * dropped first, since its parameters are what just changed.
   * @param input - `{ mode, originalLabel?, label, host, port, user?, identityFile? }`.
   * @returns the fresh catalogue and the id of the target that was written.
   */
  async saveServer(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    if (this.settings.allowConfigEdit === false) {
      throw remoteFailure(
        'ssh/config-edit-disabled',
        'Editing ~/.ssh/config from the panel is turned off. Set allowConfigEdit to true to enable it.',
      )
    }
    const mode = request.mode === 'update' ? 'update' : 'add'
    const label = cleanLabel(request.label)
    if (label.length === 0) {
      throw remoteFailure(
        'ssh/bad-label',
        'The alias must be one word: no spaces, and none of the characters * ? ! which ssh reads as a pattern.',
        { label: request.label },
      )
    }
    const host = cleanHost(request.host)
    if (host.length === 0) {
      throw remoteFailure('ssh/bad-host', 'The host must be a hostname or address with no spaces.', { host: request.host })
    }
    // Strict, not clamped: silently turning an unusable port into 22 is exactly
    // the failure this validation exists to prevent. Refusing keeps the file honest.
    const port = parsePortStrict(request.port)
    if (port === undefined) {
      throw remoteFailure(
        'ssh/bad-port',
        'The port must be a whole number from 1 to 65535.',
        { port: request.port },
      )
    }
    const user = cleanUser(request.user)
    const identityFile = cleanIdentityFile(request.identityFile)
    const fields = { host, port, user, identityFile }

    const { path, parsed } = this.loadSshConfig()
    const previous = readSshConfigHosts(this.sshConfigFile())
    const labels = parsed.blocks.filter((block) => block.label.length > 0)

    let text
    if (mode === 'update') {
      const originalLabel = cleanLabel(request.originalLabel) || label
      const block = labels.find((candidate) => candidate.label === originalLabel)
      if (block === undefined) {
        throw remoteFailure(
          'ssh/unknown-server',
          `"${originalLabel}" is not a Host block in ${path}. Nothing was changed; edit that file by hand if it lives somewhere else.`,
          { path, label: originalLabel },
        )
      }
      if (label !== originalLabel) {
        const collision = labels.find((candidate) => candidate.label === label)
        if (collision !== undefined) {
          throw remoteFailure(
            'ssh/label-exists',
            `"${label}" already exists in ${path}. Pick another alias.`,
            { path, label },
          )
        }
      }
      text = rewriteBlock(parsed, block, fields, label)
      await this.dropEditedSession(originalLabel, previous)
    } else {
      if (labels.some((candidate) => candidate.label === label)) {
        throw remoteFailure(
          'ssh/label-exists',
          `"${label}" already exists in ${path}. Pick another alias, or edit that entry instead.`,
          { path, label },
        )
      }
      text = appendBlock(parsed, fields, label)
    }

    this.commitSshConfig(path, text, { label, host, port })
    const catalogue = await this.servers({})
    return {
      ...catalogue,
      savedId: `${user ?? ''}@${host}:${port}`,
      savedLabel: label,
      mode,
    }
  }

  /**
   * Delete one target's block from `~/.ssh/config`.
   * @param input - `{ label }`.
   * @returns the fresh catalogue.
   */
  async removeServer(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    if (this.settings.allowConfigEdit === false) {
      throw remoteFailure(
        'ssh/config-edit-disabled',
        'Editing ~/.ssh/config from the panel is turned off. Set allowConfigEdit to true to enable it.',
      )
    }
    const label = cleanLabel(request.label)
    if (label.length === 0) throw remoteFailure('ssh/bad-label', 'A server alias is required.', { label: request.label })
    const { path, parsed } = this.loadSshConfig()
    const previous = readSshConfigHosts(this.sshConfigFile())
    const block = parsed.blocks.find((candidate) => candidate.label === label)
    if (block === undefined) {
      throw remoteFailure(
        'ssh/unknown-server',
        `"${label}" is not a Host block in ${path}. Nothing was changed.`,
        { path, label },
      )
    }
    // Drop the session before the file changes, so the panel cannot reconnect with
    // parameters that no longer exist anywhere.
    await this.dropEditedSession(label, previous)
    const text = removeBlock(parsed, block)
    this.commitSshConfig(path, text, { label, host: '', port: 0, remove: true })
    return await this.servers({})
  }

  /**
   * The `known_hosts` file this service honours.
   * @returns its absolute path: the configured override, else OpenSSH's default.
   */
  knownHostsFile() {
    const configured = expandHome(this.settings.knownHostsFile)
    return configured === undefined ? knownHostsPath() : configured
  }

  /**
   * Report the host key a server presents, without sending it any credentials.
   *
   * This is a deliberate preflight. The handshake is aborted the moment the key
   * arrives, so an unknown or changed host learns nothing about the local
   * identity file, password or agent, and the user can compare the fingerprint in
   * the safe order: look first, authenticate second.
   * @param input - `{ serverId }`.
   * @returns the key, its fingerprint, and what `known_hosts` already says.
   */
  async hostKey(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const serverId = typeof request.serverId === 'string' ? request.serverId : ''
    if (serverId.length === 0) throw remoteFailure('ssh/bad-request', 'A server id is required.')
    const { servers } = await this.servers({})
    const server = servers.find((entry) => entry.id === serverId)
    if (server === undefined) {
      throw remoteFailure('ssh/unknown-server', `Unknown server "${serverId}".`, { serverId })
    }
    const observed = await this.observeHostKey(server)
    const path = this.knownHostsFile()
    const entries = readKnownHosts(path)
    const status = classifyHostKey(entries, server.host, server.port, observed.keyType, observed.keyBody)
    return {
      serverId,
      host: server.host,
      port: server.port,
      keyType: observed.keyType,
      fingerprint: observed.fingerprint,
      keyBody: observed.keyBody,
      status,
      knownHostsPath: path,
    }
  }

  /**
   * Complete a key exchange only far enough to see the host key.
   *
   * No username, password, key or agent is supplied: the verifier returns false,
   * so the transport is torn down before authentication begins.
   * @param server - the target.
   * @returns the observed key type, body and fingerprint.
   */
  async observeHostKey(server) {
    return await new Promise((resolvePromise, rejectPromise) => {
      let captured
      let settled = false
      const client = new Client()
      const finish = (error) => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          // An aborted handshake often already closed the transport.
        }
        if (captured !== undefined) {
          const parts = hostKeyParts(captured)
          resolvePromise({
            keyType: parts.type,
            keyBody: parts.body,
            fingerprint: fingerprintSha256(captured),
          })
          return
        }
        rejectPromise(unreachableFailure(error, server) ?? error ?? remoteFailure(
          'ssh/host-key-unavailable',
          `${server.host} did not present a host key.`,
          { serverId: server.id },
        ))
      }
      client.on('error', (error) => finish(error))
      client.on('close', () => finish())
      client.on('ready', () => finish())
      try {
        client.connect({
          host: server.host,
          port: server.port,
          readyTimeout: 20000,
          // ssh2 insists on a username before it will dial. It is never used to
          // authenticate: the handshake is abandoned at the host key, which is
          // exchanged before any userauth request exists.
          username: server.user ?? 'probe',
          hostVerifier: (key) => {
            captured = key
            return false
          },
        })
      } catch (error) {
        finish(error)
      }
    })
  }

  /**
   * Open a connection to one target, replacing any previous one to the same host.
   *
   * The host key is checked before any credential is sent. An unknown key is
   * refused unless the caller passes back the exact fingerprint it was shown, and
   * a key that disagrees with `known_hosts` is refused outright — a changed key is
   * the signature of an interception, not of a host that has not been visited yet.
   * @param input - `{ serverId, password?, passphrase?, identityFile?, trustFingerprint? }`.
   * @returns the connected identity.
   */
  async connect(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const serverId = typeof request.serverId === 'string' ? request.serverId : ''
    if (serverId.length === 0) throw remoteFailure('ssh/bad-request', 'A server id is required.')
    const { servers } = await this.servers({})
    const server = servers.find((entry) => entry.id === serverId)
    if (server === undefined) {
      throw remoteFailure('ssh/unknown-server', `Unknown server "${serverId}".`, { serverId })
    }
    const trustFingerprint = typeof request.trustFingerprint === 'string' && request.trustFingerprint.length > 0
      ? request.trustFingerprint
      : undefined
    // Only this host's previous session is replaced; other hosts stay connected.
    await this.disconnect({ serverId })

    const options = {
      host: server.host,
      port: server.port,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
    }
    if (server.user !== undefined && server.user.length > 0) options.username = server.user
    const identityFile = expandHome(request.identityFile) ?? server.identityFile
    const passphrase = typeof request.passphrase === 'string' && request.passphrase.length > 0
      ? request.passphrase
      : undefined
    const password = typeof request.password === 'string' && request.password.length > 0
      ? request.password
      : undefined

    if (password !== undefined) {
      options.password = password
    } else {
      const loaded = this.loadIdentity(identityFile, passphrase)
      if (loaded !== undefined) options.privateKey = loaded
    }
    if (options.privateKey === undefined && options.password === undefined) {
      options.agent = process.platform === 'win32'
        ? '\\\\.\\pipe\\openssh-ssh-agent'
        : (process.env.SSH_AUTH_SOCK ?? undefined)
      if (options.agent === undefined) {
        throw remoteFailure(
          'ssh/no-credentials',
          `No usable credential for ${server.host}: no password given, no identity file found, and no ssh-agent socket.`,
          { serverId },
        )
      }
    }

    // Whatever the handshake decides is recorded here so the failure raised after
    // the transport aborts can name the actual reason instead of a generic one.
    let keyRefusal
    const keyFile = this.knownHostsFile()
    const knownHosts = readKnownHosts(keyFile)
    options.hostVerifier = (key) => {
      const parts = hostKeyParts(key)
      const fingerprint = fingerprintSha256(key)
      const status = classifyHostKey(knownHosts, server.host, server.port, parts.type, parts.body)
      if (status === 'trusted') return true
      if (status === 'unknown' && trustFingerprint !== undefined && trustFingerprint === fingerprint) {
        if (!appendKnownHost(keyFile, server.host, server.port, parts.type, parts.body)) {
          keyRefusal = remoteFailure(
            'ssh/host-key-unwritable',
            `The host key for ${server.host} was accepted but ${keyFile} could not be written, so the next connection will ask again.`,
            { serverId, fingerprint },
          )
          return false
        }
        return true
      }
      keyRefusal = status === 'mismatch'
        ? remoteFailure(
          'ssh/host-key-mismatch',
          `${server.host} presented a host key that does not match ${keyFile} (${fingerprint}). This is what an intercepted connection looks like; if the server's key really was replaced, remove the old entry yourself.`,
          { serverId, fingerprint, keyType: parts.type, status },
        )
        : status === 'revoked'
          ? remoteFailure(
            'ssh/host-key-revoked',
            `${server.host} presented a key that ${keyFile} marks as revoked (${fingerprint}).`,
            { serverId, fingerprint, keyType: parts.type, status },
          )
          : remoteFailure(
            'ssh/host-key-unknown',
            `${server.host} is not in ${keyFile} yet. Its ${parts.type} key is ${fingerprint}. Confirm it before connecting.`,
            { serverId, fingerprint, keyType: parts.type, status },
          )
      return false
    }

    const client = new Client()
    const session = { client, server, connected: false, cpuSample: undefined, since: Date.now() }
    this.sessions.set(serverId, session)

    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const settle = (error) => {
        if (settled) return
        settled = true
        if (error === undefined) resolvePromise()
        else rejectPromise(error)
      }
      const markClosed = () => {
        if (this.sessions.get(serverId) !== session) return
        session.connected = false
        session.client = undefined
      }
      client.on('ready', () => settle())
      client.on('error', (error) => {
        markClosed()
        settle(unreachableFailure(error, server) ?? error)
      })
      client.on('close', () => {
        markClosed()
        settle(remoteFailure('ssh/closed', 'The SSH connection closed before it was ready.', { serverId }))
      })
      try {
        client.connect(options)
      } catch (error) {
        settle(error)
      }
    }).catch((error) => {
      discardSession(this, serverId, session)
      // A refused host key is the real reason the transport died; the error ssh2
      // raises for a failed verification says nothing a user can act on.
      if (keyRefusal !== undefined) throw keyRefusal
      throw this.describe(error, server)
    })

    session.connected = true
    let probe
    try {
      probe = await this.run(
        session,
        'echo "###HOST"; hostname 2>/dev/null; echo "###UNAME"; uname -sr 2>/dev/null; '
        + 'echo "###STAT"; head -1 /proc/stat 2>/dev/null; echo "###END"',
        15000,
      )
    } catch (error) {
      discardSession(this, serverId, session)
      throw this.describe(error, server)
    }
    const sections = splitSections(probe.stdout)
    session.hostname = sectionLine(sections, 'HOST')
    session.os = sectionLine(sections, 'UNAME')
    // Seed the CPU baseline here so the very first metrics poll already carries a
    // percentage instead of waiting one interval for a second sample.
    session.cpuSample = parseCpuStat(sectionLine(sections, 'STAT'))
    return { server: this.publicServer(server), hostname: session.hostname, os: session.os }
  }

  /**
   * Load an identity file, preferring the requested one and falling back to the
   * usual defaults.
   * @param identityFile - explicit path, or undefined.
   * @param passphrase - optional key passphrase.
   * @returns the private key buffer, or undefined when none could be read.
   */
  loadIdentity(identityFile, passphrase) {
    const candidates = []
    if (identityFile !== undefined) candidates.push(identityFile)
    for (const name of DEFAULT_IDENTITIES) candidates.push(join(homedir(), '.ssh', name))
    for (const candidate of candidates) {
      try {
        if (!existsSync(candidate)) continue
        const stat = statSync(candidate)
        if (!stat.isFile() || stat.size === 0) continue
        const key = readFileSync(candidate)
        return passphrase === undefined ? key : { key, passphrase }
      } catch {
        continue
      }
    }
    return undefined
  }

  /**
   * Report every live session without touching the network.
   * @param input - unused; the wire requires one field per declared parameter.
   * @returns the connection states, in connect order.
   */
  async status(input) {
    void input
    const sessions = []
    for (const [serverId, session] of this.sessions) {
      sessions.push({
        serverId,
        connected: session.connected === true,
        server: session.server === undefined ? undefined : this.publicServer(session.server),
        hostname: session.hostname,
        os: session.os,
        since: session.since,
      })
    }
    return { sessions }
  }

  /**
   * Close one session, or every session when no id is given.
   * @param input - `{ serverId? }`.
   * @returns the ids that were closed.
   */
  async disconnect(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const requested = typeof request.serverId === 'string' ? request.serverId : ''
    const targets = requested.length > 0
      ? (this.sessions.has(requested) ? [[requested, this.sessions.get(requested)]] : [])
      : [...this.sessions]
    const closed = []
    for (const [serverId, session] of targets) {
      if (this.sessions.get(serverId) === session) this.sessions.delete(serverId)
      closed.push(serverId)
      // Every terminal on this server goes with it; a PTY cannot outlive the
      // connection that carries it.
      for (const [termId, terminal] of this.terminalsOf(serverId)) {
        this.terminals.delete(terminalKey(serverId, termId))
        terminal.exited = true
        try {
          terminal.stream.end()
        } catch {
          // A PTY whose channel is gone needs no teardown.
        }
      }
      if (session.client !== undefined) {
        try {
          session.client.end()
        } catch {
          // A connection that is already gone needs no further teardown.
        }
      }
    }
    return { closedIds: closed }
  }

  /**
   * Resolve one session by the request's `serverId`, falling back to the only
   * live session so a single-target page needs no id.
   * @param request - the Remote input object.
   * @returns the live session.
   */
  sessionFor(request) {
    const requested = typeof request?.serverId === 'string' ? request.serverId : ''
    if (requested.length > 0) {
      const session = this.sessions.get(requested)
      if (session === undefined || session.connected !== true || session.client === undefined) {
        throw remoteFailure('ssh/not-connected', `Not connected to "${requested}".`, { serverId: requested })
      }
      return session
    }
    if (this.sessions.size === 1) {
      const only = [...this.sessions.values()][0]
      if (only.connected === true && only.client !== undefined) return only
    }
    throw remoteFailure(
      'ssh/not-connected',
      this.sessions.size === 0
        ? 'Not connected to any server.'
        : 'This request must name a server: more than one is connected.',
    )
  }

  /**
   * An SFTP channel on one session, opening it on first use.
   *
   * Kept per session rather than per call: opening a subsystem is a round trip,
   * and the browser reads a directory every time a folder is opened.
   * @param session - the live session.
   * @returns the channel, or undefined when the server has no SFTP subsystem.
   */
  async sftpFor(session) {
    if (session.sftp !== undefined) return session.sftp
    if (session.sftpUnavailable === true) return undefined
    const channel = await new Promise((resolvePromise) => {
      try {
        session.client.sftp((error, value) => resolvePromise(error === undefined || error === null ? value : undefined))
      } catch {
        resolvePromise(undefined)
      }
    })
    if (channel === undefined) {
      // Remembered so a server without SFTP does not pay a failed attempt on
      // every directory the user opens.
      session.sftpUnavailable = true
      return undefined
    }
    session.sftp = channel
    // A channel dies with its connection; dropping the reference lets the next
    // read reconnect rather than reuse a husk.
    channel.on?.('close', () => {
      if (session.sftp === channel) session.sftp = undefined
    })
    channel.on?.('error', () => {
      if (session.sftp === channel) session.sftp = undefined
    })
    return channel
  }

  /**
   * Read one directory over SFTP.
   *
   * This is the path that works everywhere. The shell walk it replaces needed GNU
   * `stat`, which is absent on macOS and the BSDs: those servers refused to list
   * at all. SFTP's `readdir` returns every entry's attributes in a single reply,
   * so it is also one round trip instead of a `stat` process per file — measured
   * at parity on Linux, where the round trip dominates either way.
   * @param channel - the SFTP channel.
   * @param path - the directory to read.
   * @returns `{ path, entries, truncated }`, or undefined when the read failed.
   */
  async readDirOverSftp(channel, path) {
    const listed = await new Promise((resolvePromise) => {
      channel.readdir(path, (error, value) => {
        if (error !== undefined && error !== null) {
          resolvePromise({ error })
          return
        }
        resolvePromise({ entries: value })
      })
    })
    if (listed.error !== undefined) return undefined
    const entries = []
    for (const entry of listed.entries) {
      const kind = sftpKind(entry)
      // `.` and `..` are not useful rows in a browser that has an up button.
      if (entry.filename === '.' || entry.filename === '..') continue
      entries.push({
        name: entry.filename,
        kind,
        sizeBytes: Number.isFinite(entry.attrs?.size) ? entry.attrs.size : 0,
        modifiedMs: Number.isFinite(entry.attrs?.mtime) ? entry.attrs.mtime * 1000 : 0,
      })
    }
    entries.sort((left, right) => {
      const leftDir = left.kind === 'directory' ? 0 : 1
      const rightDir = right.kind === 'directory' ? 0 : 1
      if (leftDir !== rightDir) return leftDir - rightDir
      return left.name.localeCompare(right.name)
    })
    return {
      path,
      entries: entries.slice(0, MAX_DIR_ENTRIES),
      truncated: entries.length > MAX_DIR_ENTRIES,
    }
  }

  /**
   * List one remote directory. Read-only.
   *
   * SFTP first, because it needs no remote tooling at all and works on servers
   * without GNU `stat`. The shell walk remains as a fallback for servers that do
   * not run an SFTP subsystem, which is a real configuration on hardened hosts.
   * @param input - `{ path }`.
   * @returns the resolved path and its entries.
   */
  async listDir(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const requested = typeof request.path === 'string' && request.path.trim().length > 0
      ? request.path.trim()
      : '~'
    const session = this.sessionFor(request)

    // SFTP resolves `~` itself, but a bare `~` or one containing `..` comes back
    // as typed, so the resolved form is obtained separately when it is not already
    // known: the breadcrumb needs a real absolute path, or it renders a relative
    // segment as if it were a directory name. A clean absolute path is used as-is
    // rather than paying a round trip to be told what it already is.
    const channel = await this.sftpFor(session)
    if (channel !== undefined) {
      let resolved = isCleanAbsolute(requested) ? requested.replace(/\/+$/u, '') || '/' : undefined
      if (resolved === undefined) {
        resolved = await new Promise((resolvePromise) => {
          channel.realpath(requested, (error, value) => {
            resolvePromise(error === undefined || error === null ? value : undefined)
          })
        })
      }
      if (resolved !== undefined) {
        const listed = await this.readDirOverSftp(channel, resolved)
        if (listed !== undefined) return listed
      }
    }

    const target = remotePathExpr(requested)
    const script = [
      `cd -- ${target} 2>/dev/null || { echo "###ERR"; echo "no such directory"; echo "###END"; exit 0; }`,
      'echo "###PWD"',
      'pwd -P',
      'echo "###ENTRIES"',
      'if ! stat -c "%f|%s|%Y|%n" -- . >/dev/null 2>&1; then',
      '  echo "###ERR"',
      '  echo "this server has no GNU stat; the read-only browser needs it"',
      '  echo "###END"',
      '  exit 0',
      'fi',
      'for p in ./* ./.[!.]* ./..?*; do',
      '  [ -e "$p" ] || [ -L "$p" ] || continue',
      `  stat -c '%f|%s|%Y|%n' -- "$p" 2>/dev/null || printf '?|0|0|%s\\n' "$p"`,
      'done',
      'echo "###END"',
    ].join('\n')
    const result = await this.run(session, script, 20000)
    const sections = splitSections(result.stdout)
    const error = sectionLine(sections, 'ERR')
    if (error.length > 0) {
      throw remoteFailure('ssh/no-such-directory', `Cannot open ${requested}: ${error}`, { path: requested })
    }
    const path = sectionLine(sections, 'PWD')
    const entries = []
    for (const line of sectionLines(sections, 'ENTRIES')) {
      const entry = parseStatRow(line)
      if (entry === undefined) continue
      entries.push(entry)
    }
    entries.sort((left, right) => {
      const leftDir = left.kind === 'directory' ? 0 : 1
      const rightDir = right.kind === 'directory' ? 0 : 1
      if (leftDir !== rightDir) return leftDir - rightDir
      return left.name.localeCompare(right.name)
    })
    return {
      path: path.length > 0 ? path : requested,
      entries: entries.slice(0, MAX_DIR_ENTRIES),
      truncated: entries.length > MAX_DIR_ENTRIES,
    }
  }

  /**
   * Read the head of one text file. Read-only.
   * @param input - `{ path, maxBytes? }`.
   * @returns the preview and whether it was clipped or is binary.
   */
  async readText(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const requested = typeof request.path === 'string' ? request.path.trim() : ''
    if (requested.length === 0) throw remoteFailure('ssh/bad-request', 'A file path is required.')
    const maxBytes = clampNumber(request.maxBytes, MAX_PREVIEW_BYTES, 1024, MAX_PREVIEW_BYTES)
    const session = this.sessionFor(request)
    const target = remotePathExpr(requested)
    const script = [
      `[ -f ${target} ] || { echo "###ERR"; echo "not a regular file"; echo "###END"; exit 0; }`,
      'echo "###SIZE"',
      `stat -c '%s' -- ${target} 2>/dev/null || echo 0`,
      'echo "###DATA"',
      `head -c ${maxBytes} -- ${target} 2>/dev/null`,
      'echo',
      'echo "###END"',
    ].join('\n')
    const result = await this.run(session, script, 25000)
    const sections = splitSections(result.stdout)
    const error = sectionLine(sections, 'ERR')
    if (error.length > 0) {
      throw remoteFailure('ssh/not-a-file', `Cannot read ${requested}: ${error}`, { path: requested })
    }
    const sizeBytes = Number(sectionLine(sections, 'SIZE')) || 0
    const text = sectionLines(sections, 'DATA').join('\n')
    return {
      path: requested,
      text: text.includes('\u0000') ? '' : text,
      binary: text.includes('\u0000'),
      truncated: sizeBytes > maxBytes || result.truncated,
      sizeBytes,
    }
  }

  /**
   * Sample one remote machine once: CPU, memory, load, GPU devices, disk, top
   * processes. CPU utilization needs two samples, so the previous `/proc/stat`
   * reading is kept per session and the figure appears from the second poll on.
   * @param input - `{ serverId? }`.
   * @returns the snapshot.
   */
  async metrics(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const session = this.sessionFor(request)
    const result = await this.run(session, METRICS_SCRIPT, 25000)
    const sections = splitSections(result.stdout)
    const stat = parseCpuStat(sectionLine(sections, 'STAT'))
    const percent = cpuPercent(session.cpuSample, stat)
    if (stat !== undefined) session.cpuSample = stat

    const gpuLines = sectionLines(sections, 'GPU')
    const gpuSupported = !(gpuLines.length === 1 && gpuLines[0].trim() === 'NOGPU')
    const gpus = gpuSupported ? gpuLines.map(parseGpuRow).filter(Boolean) : []

    const loadText = sectionLine(sections, 'LOAD')
    const loadParts = loadText.split(/\s+/)
    const load = [0, 1, 2].map((index) => {
      const value = Number(loadParts[index])
      return Number.isFinite(value) ? value : 0
    })

    const processes = sectionLines(sections, 'TOP')
      .map(parseProcessRow)
      .filter(Boolean)
      .slice(0, 16)

    // GPU processes: join the device uuid back to its index, and the pid back to
    // its owner and command line, so a row reads like nvitop's process list.
    //
    // nvidia-smi lists compute processes in an arbitrary order, not by device,
    // so the rows are sorted by card and then by reserved memory. Capping the
    // list here would otherwise drop whichever cards happened to land last.
    const uuidToIndex = new Map()
    for (const device of gpus) {
      if (device.uuid !== undefined) uuidToIndex.set(device.uuid, device.index)
    }
    const owners = new Map()
    for (const row of sectionLines(sections, 'GPUAPPOWNERS').map(parseGpuAppOwnerRow)) {
      if (row !== undefined) owners.set(row.pid, row)
    }
    const gpuProcesses = sectionLines(sections, 'GPUAPPS')
      .map(parseGpuAppRow)
      .filter((row) => row !== undefined)
      .map((row) => {
        const owner = owners.get(row.pid)
        return {
          pid: row.pid,
          gpuIndex: uuidToIndex.get(row.uuid),
          usedMiB: row.usedMiB,
          user: owner?.user,
          command: owner?.command,
        }
      })
      .sort((left, right) => (
        (left.gpuIndex ?? Number.MAX_SAFE_INTEGER) - (right.gpuIndex ?? Number.MAX_SAFE_INTEGER)
        || (right.usedMiB ?? 0) - (left.usedMiB ?? 0)
        || left.pid - right.pid
      ))
      .slice(0, MAX_GPU_PROCESSES)

    // Per-device rollup, which is what makes a card answer "who is on this GPU".
    for (const device of gpus) {
      const mine = gpuProcesses.filter((process) => process.gpuIndex === device.index)
      device.processCount = mine.length
      device.processMemoryMiB = mine.reduce((sum, process) => sum + (process.usedMiB ?? 0), 0)
    }

    const diskText = sectionLine(sections, 'DISK')
    const diskFields = diskText.split(/\s+/)

    return {
      sampledAt: Date.now(),
      hostname: sectionLine(sections, 'HOST'),
      os: sectionLine(sections, 'UNAME'),
      uptimeSeconds: Number(sectionLine(sections, 'UPTIME')) || undefined,
      cpu: {
        percent,
        cores: Number(sectionLine(sections, 'NPROC')) || undefined,
        load,
      },
      memory: parseMemory(sectionLines(sections, 'MEM')),
      gpu: { supported: gpuSupported, devices: gpus },
      gpuProcesses,
      disk: diskFields.length >= 6
        ? {
          filesystem: diskFields[0],
          size: diskFields[1],
          used: diskFields[2],
          available: diskFields[3],
          usedPercent: Number.parseInt(diskFields[4], 10) || 0,
          mount: diskFields[5],
        }
        : undefined,
      processes,
    }
  }

  /**
   * Run one command on the remote host and capture its output.
   * @param input - `{ command, timeoutMs? }`.
   * @returns stdout, stderr, exit code and timing.
   */
  async exec(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const command = typeof request.command === 'string' ? request.command : ''
    if (command.trim().length === 0) throw remoteFailure('ssh/bad-request', 'A command is required.')
    const timeoutMs = clampNumber(request.timeoutMs, this.settings.execTimeoutMs, 1000, 600000)
    const session = this.sessionFor(request)
    const started = Date.now()
    const result = await this.run(session, command, timeoutMs)
    return {
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      truncated: result.truncated,
    }
  }

  /**
   * The terminals open on one server, in creation order.
   * @param serverId - the server id.
   * @returns `[termId, terminal]` pairs.
   */
  terminalsOf(serverId) {
    const prefix = `${serverId}${TERM_KEY_SEPARATOR}`
    return [...this.terminals]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, terminal]) => [key.slice(prefix.length), terminal])
  }

  /**
   * Resolve one terminal on the request's server.
   *
   * A request may name its terminal. When it does not, a server holding exactly
   * one answers for it; anything else is refused rather than guessed, because a
   * guess types into the wrong shell.
   * @param request - the Remote input.
   * @returns `{ session, termId, terminal }`.
   */
  terminalFor(request) {
    const session = this.sessionFor(request)
    const serverId = session.server.id
    const requested = typeof request.termId === 'string' ? request.termId.trim() : ''
    if (requested.length > 0) {
      const terminal = this.terminals.get(terminalKey(serverId, requested))
      if (terminal === undefined) {
        throw remoteFailure('ssh/no-terminal', 'That terminal is not open on this server.', {
          serverId,
          termId: requested,
        })
      }
      return { session, termId: requested, terminal }
    }
    const mine = this.terminalsOf(serverId)
    if (mine.length === 1) return { session, termId: mine[0][0], terminal: mine[0][1] }
    if (mine.length === 0) {
      throw remoteFailure('ssh/no-terminal', 'No terminal is open on this server.', { serverId })
    }
    throw remoteFailure('ssh/ambiguous-terminal', 'Several terminals are open on this server; name one.', {
      serverId,
      termIds: mine.map(([termId]) => termId),
    })
  }

  /**
   * Open an interactive PTY on the session's connection, or re-attach to one
   * that is already open.
   *
   * The remote side gets a real terminal — the same allocation `ssh` gives an
   * interactive login — so prompts, colours, line editing and full-screen
   * programs all behave as they do in a native terminal.
   *
   * A server can hold several terminals at once (bounded by
   * `MAX_TERMINALS_PER_SERVER`), each an independent login with its own scrollback
   * and its own window size. A terminal outlives the view that opened it: leaving
   * the tab or switching host only detaches the Client, so coming back replays the
   * retained output instead of starting a fresh login. `termClose` is the explicit
   * teardown.
   * @param input - `{ serverId?, termId?, cols?, rows? }`.
   * @returns the terminal id, cursor and whether this re-attached.
   */
  async termOpen(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const session = this.sessionFor(request)
    const serverId = session.server.id
    const client = session.client
    if (client === undefined) throw remoteFailure('ssh/not-connected', 'Not connected to any server.')
    const cols = clampNumber(request.cols, 100, 20, 500)
    const rows = clampNumber(request.rows, 30, 5, 200)

    const mine = this.terminalsOf(serverId)
    const requested = typeof request.termId === 'string' ? request.termId.trim() : ''
    const termId = requested.length > 0 ? requested : nextTerminalId(mine.map(([id]) => id))
    const key = terminalKey(serverId, termId)

    const existing = this.terminals.get(key)
    if (existing !== undefined && !existing.exited) {
      // The Client owns the geometry: it is the one with a window to fit.
      if (cols !== existing.cols || rows !== existing.rows) {
        existing.cols = cols
        existing.rows = rows
        try {
          existing.stream.setWindow(rows, cols, 0, 0)
        } catch {
          // A channel that died between the read and the resize needs no error.
        }
      }
      return {
        termId,
        cols,
        rows,
        seq: existing.seq,
        start: existing.start,
        attached: true,
        exited: false,
      }
    }
    if (existing === undefined && mine.length >= MAX_TERMINALS_PER_SERVER) {
      throw remoteFailure(
        'ssh/too-many-terminals',
        `This server already has ${mine.length} terminals; close one first.`,
        { serverId, limit: MAX_TERMINALS_PER_SERVER },
      )
    }
    // A terminal that has exited is replaced under the same id, so the Client's
    // layout keeps its slot.
    if (existing !== undefined) this.terminals.delete(key)

    const stream = await new Promise((resolvePromise, rejectPromise) => {
      try {
        client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
          if (error !== undefined && error !== null) rejectPromise(error)
          else resolvePromise(channel)
        })
      } catch (error) {
        rejectPromise(error)
      }
    }).catch((error) => {
      throw remoteFailure(
        'ssh/terminal-unavailable',
        `Cannot open a terminal on this server — ${error instanceof Error ? error.message : String(error)}.`,
      )
    })

    const terminal = {
      stream,
      cols,
      rows,
      /** Bytes appended so far; the Client's cursor into the scrollback. */
      seq: 0,
      /** First byte still retained, so a stale cursor is detectable. */
      start: 0,
      chunks: [],
      retained: 0,
      exited: false,
      exitCode: undefined,
    }
    const capture = (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
      terminal.chunks.push(buffer)
      terminal.retained += buffer.length
      terminal.seq += buffer.length
      // Keep the tail bounded; a Chatty command must not grow Host memory without
      // limit. The Client is told to reset when its cursor falls off the front.
      while (terminal.retained > MAX_TERM_SCROLLBACK_BYTES && terminal.chunks.length > 1) {
        const dropped = terminal.chunks.shift()
        terminal.retained -= dropped.length
        terminal.start += dropped.length
      }
    }
    stream.on('data', capture)
    stream.stderr.on('data', capture)
    stream.on('close', (code) => {
      terminal.exited = true
      terminal.exitCode = code
    })
    stream.on('error', () => {
      terminal.exited = true
    })
    this.terminals.set(key, terminal)
    return { termId, cols, rows, seq: 0, start: 0, attached: false, exited: false }
  }

  /**
   * List the terminals open on the request's server.
   *
   * The Client calls this after a reload: its own state is gone, but the Host
   * still holds the shells, so the layout can be rebuilt instead of replaced.
   * @param input - `{ serverId? }`.
   * @returns one entry per terminal.
   */
  async termList(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const session = this.sessionFor(request)
    return {
      terminals: this.terminalsOf(session.server.id).map(([termId, terminal]) => ({
        termId,
        cols: terminal.cols,
        rows: terminal.rows,
        seq: terminal.seq,
        start: terminal.start,
        exited: terminal.exited,
        exitCode: terminal.exitCode,
      })),
    }
  }

  /**
   * Read terminal output after a cursor.
   *
   * Polling keeps the transport request/response only; a shell shows the echo of
   * a keystroke within one poll interval, which is what a remote console needs.
   * @param input - `{ serverId?, termId?, fromSeq? }`.
   * @returns the new bytes as base64, plus whether the cursor must reset.
   */
  async termRead(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const { termId, terminal } = this.terminalFor(request)
    const fromSeq = Number.isFinite(request.fromSeq) ? Math.max(0, Math.trunc(request.fromSeq)) : 0
    // A cursor older than the retained window can no longer be resumed: resend
    // everything and let the Client clear its screen first.
    const reset = fromSeq < terminal.start
    const startAt = reset ? terminal.start : fromSeq
    let skip = startAt - terminal.start
    const parts = []
    for (const chunk of terminal.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length
        continue
      }
      parts.push(skip > 0 ? chunk.subarray(skip) : chunk)
      skip = 0
    }
    return {
      seq: terminal.seq,
      start: terminal.start,
      reset,
      data: Buffer.concat(parts).toString('base64'),
      exited: terminal.exited,
      exitCode: terminal.exitCode,
      cols: terminal.cols,
      rows: terminal.rows,
    }
  }

  /**
   * Send keystrokes to one terminal.
   * @param input - `{ serverId?, termId?, data }` where `data` is base64.
   * @returns the accepted byte count.
   */
  async termWrite(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const { terminal } = this.terminalFor(request)
    if (terminal.exited) {
      throw remoteFailure('ssh/no-terminal', 'That terminal has exited.', { termId: request.termId })
    }
    const payload = typeof request.data === 'string' ? Buffer.from(request.data, 'base64') : Buffer.alloc(0)
    if (payload.length > 0) terminal.stream.write(payload)
    return { written: payload.length }
  }

  /**
   * Resize one remote PTY.
   * @param input - `{ serverId?, termId?, cols, rows }`.
   * @returns the applied size.
   */
  async termResize(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const { terminal } = this.terminalFor(request)
    if (terminal.exited) {
      throw remoteFailure('ssh/no-terminal', 'That terminal has exited.', { termId: request.termId })
    }
    const cols = clampNumber(request.cols, terminal.cols, 20, 500)
    const rows = clampNumber(request.rows, terminal.rows, 5, 200)
    if (cols === terminal.cols && rows === terminal.rows) return { cols, rows }
    terminal.cols = cols
    terminal.rows = rows
    try {
      terminal.stream.setWindow(rows, cols, 0, 0)
    } catch {
      // A channel that closed between the read and the resize needs no error.
    }
    return { cols, rows }
  }

  /**
   * Close one terminal, or every terminal on the server, without touching the
   * SSH connection.
   * @param input - `{ serverId?, termId? }`.
   * @returns the ids that were closed.
   */
  async termClose(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const requestedServer = typeof request.serverId === 'string' ? request.serverId : ''
    const serverId = requestedServer.length > 0
      ? requestedServer
      : (this.sessions.size === 1 ? [...this.sessions.keys()][0] : '')
    if (serverId.length === 0) return { closedIds: [], closed: false }
    const requested = typeof request.termId === 'string' ? request.termId.trim() : ''
    const targets = requested.length > 0
      ? this.terminalsOf(serverId).filter(([termId]) => termId === requested)
      : this.terminalsOf(serverId)
    const closedIds = []
    for (const [termId, terminal] of targets) {
      this.terminals.delete(terminalKey(serverId, termId))
      terminal.exited = true
      try {
        terminal.stream.end()
      } catch {
        // Already gone.
      }
      closedIds.push(termId)
    }
    return { closedIds, closed: closedIds.length > 0 }
  }

  /**
   * Run one command over the session's connection.
   * @param session - the live session.
   * @param command - shell command text.
   * @param timeoutMs - ceiling before the channel is closed.
   * @returns captured output.
   */
  async run(session, command, timeoutMs) {
    const client = session.client
    if (client === undefined) throw remoteFailure('ssh/not-connected', 'Not connected to any server.')
    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let truncated = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          stream?.signal('TERM')
        } catch {
          // The channel may already be gone.
        }
        try {
          stream?.close()
        } catch {
          // Closing a finished channel is not an error.
        }
        finish(undefined, 124)
      }, timeoutMs)
      let stream
      const cleanup = () => {
        clearTimeout(timer)
      }
      const finish = (error, code) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) {
          rejectPromise(error)
          return
        }
        resolvePromise({ stdout, stderr, code: code ?? 0, timedOut, truncated })
      }
      const append = (chunk, target) => {
        const text = chunk.toString('utf8')
        if (target === 'out') {
          if (stdout.length + text.length > MAX_CAPTURED_BYTES) {
            truncated = true
            stdout = `${stdout}${text}`.slice(-MAX_CAPTURED_BYTES)
            return
          }
          stdout += text
          return
        }
        if (stderr.length + text.length > MAX_CAPTURED_BYTES) {
          truncated = true
          stderr = `${stderr}${text}`.slice(-MAX_CAPTURED_BYTES)
          return
        }
        stderr += text
      }
      try {
        client.exec(command, (error, channel) => {
          if (error !== undefined && error !== null) {
            finish(error)
            return
          }
          stream = channel
          channel.on('data', (chunk) => append(chunk, 'out'))
          channel.stderr.on('data', (chunk) => append(chunk, 'err'))
          channel.on('close', (code) => finish(undefined, code))
          channel.on('error', (channelError) => finish(channelError))
        })
      } catch (error) {
        finish(error)
      }
    })
  }

  /**
   * Strip the fields the Client does not need from a target.
   * @param server - one internal target.
   * @returns its public shape.
   */
  publicServer(server) {
    return {
      id: server.id,
      label: server.label,
      host: server.host,
      port: server.port,
      user: server.user,
      source: server.source,
    }
  }

  /**
   * Turn a technical failure into a message a person can act on.
   * @param error - the underlying failure.
   * @param server - the target it happened against.
   * @returns the marked Remote failure.
   */
  describe(error, server) {
    if (error !== null && typeof error === 'object' && error.isDSHRemoteError === true) return error
    const raw = error instanceof Error ? error.message : String(error)
    const hint = /authentication|permission denied/i.test(raw)
      ? ' Authentication was rejected: this target needs a password or a different key.'
      : /timed? ?out|ETIMEDOUT/i.test(raw)
        ? ' The host did not answer in time.'
        : ''
    return remoteFailure('ssh/connect-failed', `Cannot connect to ${server.host}:${server.port} — ${raw}.${hint}`, {
      host: server.host,
      port: server.port,
    })
  }
}

/**
 * Drop a half-open session without touching a newer one.
 * @param service - the owning service.
 * @param serverId - the target the session belongs to.
 * @param session - the session that failed.
 */
function discardSession(service, serverId, session) {
  if (service.sessions.get(serverId) !== session) return
  service.sessions.delete(serverId)
  try {
    session.client?.end()
  } catch {
    // A connection that never came up needs no teardown.
  }
}

Object.defineProperty(SshConsoleService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({
      method,
      invocation: Object.freeze({ kind: 'direct' }),
    }))),
  }),
})

/**
 * Register the Remote Service and close the connection when the plugin unloads.
 * @param ctx - Host plugin context.
 * @param config - the Loader row's `config` object.
 */
export function apply(ctx, config) {
  const service = new SshConsoleService(ctx, config)
  ctx.provide(SERVICE_KEY, service)
  ctx.effect(() => () => {
    void service.disconnect({})
  }, 'ssh-console: connections')
}

/**
 * Editing primitives, exported for the test suite.
 *
 * These are pure string operations on ssh_config text. They are exported so the
 * preservation guarantees can be asserted directly against real-shaped files
 * without going near the user's own config.
 */
export {
  SshConsoleService,
  appendBlock,
  cleanHost,
  cleanLabel,
  cleanUser,
  clampNumber,
  parsePortStrict,
  parseSshConfig,
  readSshConfigHosts,
  removeBlock,
  rewriteBlock,
}
