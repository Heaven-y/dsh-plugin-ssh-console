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
 * @module @coder02lq/dsh-plugin-ssh-console
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
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
 * Read `~/.ssh/config` into connect targets.
 *
 * Only the fields this plugin needs are understood; `Include`, `Match` and every
 * other directive are ignored, and wildcard patterns are skipped because they
 * describe defaults rather than a server a person would pick from a list.
 * @returns the declared hosts, in file order.
 */
function readSshConfigHosts() {
  const path = join(homedir(), '.ssh', 'config')
  let text
  try {
    if (!existsSync(path)) return []
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const hosts = []
  let current
  const flush = () => {
    if (current === undefined) return
    const host = current.host ?? current.label
    if (host.length > 0) {
      const port = clampNumber(current.port, 22, 1, 65535)
      hosts.push({
        id: `${current.user ?? ''}@${host}:${port}`,
        label: current.label,
        host,
        port,
        user: current.user,
        identityFile: current.identityFile,
        source: 'ssh-config',
      })
    }
    current = undefined
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = /^(\w+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()
    if (keyword === 'host') {
      flush()
      const patterns = value.split(/\s+/)
      const literal = patterns.filter((pattern) => !/[*?!]/.test(pattern))
      // A block made only of wildcards (`Host *`) carries defaults, not a target.
      if (literal.length === 0) continue
      current = { label: literal[0], host: undefined, port: 22, user: undefined, identityFile: undefined }
      continue
    }
    if (current === undefined) continue
    if (keyword === 'hostname') current.host = value
    else if (keyword === 'port') current.port = Number(value)
    else if (keyword === 'user') current.user = value
    else if (keyword === 'identityfile') current.identityFile = value
  }
  flush()
  return hosts
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
 * The device name is free text and may itself contain commas, so the fixed-width
 * numeric tail is taken from the end and everything between is the name.
 * @param line - one CSV row of `index,name,util,memused,memtotal,temp,power`.
 * @returns the parsed device, or undefined for a line that does not match.
 */
function parseGpuRow(line) {
  const parts = String(line).split(',').map((part) => part.trim())
  if (parts.length < 7) return undefined
  const index = Number(parts[0])
  if (!Number.isFinite(index)) return undefined
  const tail = parts.slice(-5)
  const numeric = (value) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return {
    index,
    name: parts.slice(1, parts.length - 5).join(', '),
    utilization: numeric(tail[0]),
    memoryUsedMiB: numeric(tail[1]),
    memoryTotalMiB: numeric(tail[2]),
    temperatureC: numeric(tail[3]),
    powerW: numeric(tail[4]),
  }
}

/**
 * Parse one `index,uuid` row from `--query-gpu`.
 * @param line - one CSV row.
 * @returns the mapping, or undefined when the row does not match.
 */
function parseGpuUuidRow(line) {
  const parts = String(line).split(',').map((part) => part.trim())
  if (parts.length < 2) return undefined
  const index = Number(parts[0])
  if (!Number.isFinite(index) || parts[1].length === 0) return undefined
  return { index, uuid: parts[1] }
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
    + 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw '
    + '--format=csv,noheader,nounits 2>/dev/null; else echo NOGPU; fi',
  'echo "###GPUUUID"',
  'if command -v nvidia-smi >/dev/null 2>&1; then '
    + 'nvidia-smi --query-gpu=index,uuid --format=csv,noheader 2>/dev/null; fi',
  'echo "###GPUAPPS"',
  'if command -v nvidia-smi >/dev/null 2>&1; then '
    + 'nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory '
    + '--format=csv,noheader,nounits 2>/dev/null; fi',
  'echo "###GPUAPPOWNERS"',
  'apppids=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null '
    + "| tr -d ' ' | sed '/^$/d' | paste -sd, -); "
    + '[ -n "$apppids" ] && ps -o pid=,user=,args= -p "$apppids" 2>/dev/null',
  'echo "###DISK"',
  'df -P -h / 2>/dev/null | tail -n 1',
  'echo "###TOP"',
  'ps -eo pid,ppid,user,pcpu,pmem,etime,stat,nlwp,rss,args --sort=-pcpu 2>/dev/null | head -n 21',
  'echo "###END"',
].join('\n')

/* ------------------------------------------------------------------ service */

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
      })
    }
    if (this.settings.includeSshConfig) {
      for (const entry of readSshConfigHosts()) {
        push({ ...entry, identityFile: expandHome(entry.identityFile) })
      }
    }
    return {
      servers: entries,
      refreshMs: this.settings.refreshMs,
      connectedIds: [...this.sessions.keys()],
    }
  }

  /**
   * Open a connection to one target, replacing any previous one to the same host.
   * @param input - `{ serverId, password?, passphrase?, identityFile? }`.
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
        settle(error)
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
   * List one remote directory. Read-only: only `stat` and globbing run remotely.
   * @param input - `{ path }`.
   * @returns the resolved path and its entries.
   */
  async listDir(input) {
    const request = input !== null && typeof input === 'object' ? input : {}
    const requested = typeof request.path === 'string' && request.path.trim().length > 0
      ? request.path.trim()
      : '~'
    const session = this.sessionFor(request)
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
    for (const row of sectionLines(sections, 'GPUUUID').map(parseGpuUuidRow)) {
      if (row !== undefined) uuidToIndex.set(row.uuid, row.index)
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

export { SshConsoleService }
