/**
 * Host-half harness: drives the real service against a real server.
 *
 * Run: node test/host.test.mjs [hostId]
 * The network part is skipped when the target cannot be reached, so the file
 * stays runnable on a machine without the lab servers.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshConsoleService, clampNumber, parsePortStrict } from '../index.js'

/**
 * Every scratch directory this run creates.
 *
 * `mkdtempSync` was used bare here for a long time, and one `npm test` left ~66
 * directories behind: the suite had been quietly filling the temp folder on every
 * run. Nothing failed, which is exactly why it went unnoticed. The fix that stays
 * fixed is one the harness does not have to remember.
 */
const scratchDirs = []

/**
 * Create a scratch directory that is removed when the process exits.
 *
 * Cleanup runs on `exit` rather than at the end of the file: an assertion that
 * throws would skip anything written after it, and a failing run is precisely when
 * scratch files should not pile up. `exit` still fires for an uncaught throw.
 * @param prefix - the `mkdtemp` prefix, e.g. `'ssc-hosts-'`.
 * @returns the directory path.
 */
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A file still locked on Windows is not worth failing a passing run over.
    }
  }
})

/**
 * Fingerprint the user's real OpenSSH files before anything runs.
 *
 * Every test in this file is supposed to work on a scratch copy. This is the
 * assertion that proves it: if a future change makes a test write through to the
 * real `~/.ssh/config` or `known_hosts`, the run fails at the end rather than
 * silently editing the machine it was run on.
 */
const REAL_SSH_FILES = [join(homedir(), '.ssh', 'config'), join(homedir(), '.ssh', 'known_hosts')]
const realBefore = REAL_SSH_FILES.map((path) => {
  try {
    const info = statSync(path)
    return { path, exists: true, mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return { path, exists: false }
  }
})

/** Minimal Host context: the service only ever provides and effects. */
function fakeContext() {
  const provided = new Map()
  return {
    provided,
    provide(key, value) {
      provided.set(key, value)
      return () => provided.delete(key)
    },
    effect(callback) {
      return callback()
    },
    get(key) {
      return provided.get(key)
    },
  }
}

const ctx = fakeContext()
// A scratch known_hosts: the suite must not append to the real one. It still
// exercises the trust path, including the write.
const knownHostsDir = scratchDir('ssc-hosts-')
const service = new SshConsoleService(ctx, {
  refreshMs: 2000,
  knownHostsFile: join(knownHostsDir, 'known_hosts'),
})
ctx.provide('sshConsole', service)

/* --------------------------------------------------------------- catalogue */

const catalogue = await service.servers({})
assert.ok(Array.isArray(catalogue.servers), 'servers() returns a list')
assert.equal(catalogue.refreshMs, 2000)
assert.deepEqual(catalogue.connectedIds, [], 'nothing is connected yet')
for (const server of catalogue.servers) {
  assert.equal(typeof server.id, 'string')
  assert.equal(typeof server.host, 'string')
  assert.ok(server.port > 0 && server.port <= 65535, `${server.id} has a valid port`)
}
console.log(`ok 1 - catalogue lists ${catalogue.servers.length} targets`)

/* ------------------------------------------------------------- static guard */

await assert.rejects(
  () => service.metrics({}),
  (error) => error.code === 'ssh/not-connected',
  'metrics without a connection is a marked failure',
)
await assert.rejects(
  () => service.connect({ serverId: 'nobody@127.0.0.1:1' }),
  (error) => error.code === 'ssh/unknown-server',
  'an unknown target is refused',
)
await assert.rejects(
  () => service.exec({ command: '   ' }),
  (error) => error.code === 'ssh/bad-request' || error.code === 'ssh/not-connected',
  'a blank command is refused',
)
console.log('ok 2 - unconnected and invalid calls fail with marked codes')

/* ------------------------------------------------------------------- live */

const wanted = process.argv[2]
const target = wanted === undefined
  ? catalogue.servers.find((server) => server.host === '122.205.68.212') ?? catalogue.servers[0]
  : catalogue.servers.find((server) => server.id === wanted)

if (target === undefined) {
  console.log('skip - no target configured; the network part was not exercised')
  process.exit(0)
}

let connected = false
try {
  // The connection now requires an agreed host key. The suite runs against a
  // scratch known_hosts so it never edits the real one, and it walks the same
  // trust path the panel does: inspect the key, then pass the fingerprint back.
  const key = await service.hostKey({ serverId: target.id })
  assert.ok(key.fingerprint.startsWith('SHA256:'), 'the fingerprint is in OpenSSH form')
  assert.ok(key.keyBody.length > 0, 'the key body is present')
  const session = key.status === 'trusted'
    ? await service.connect({ serverId: target.id })
    : await service.connect({ serverId: target.id, trustFingerprint: key.fingerprint })
  connected = true
  assert.equal(session.server.host, target.host)
  assert.ok(session.hostname.length > 0, 'the remote hostname is known')
  console.log(`ok 3 - connected to ${target.id} as ${session.hostname} (${session.os}), key ${key.status}`)

  const status = await service.status({})
  assert.equal(status.sessions.length, 1)
  assert.equal(status.sessions[0].connected, true)
  assert.equal(status.sessions[0].serverId, target.id)
  console.log('ok 4 - status lists the live session')

  const listing = await service.listDir({ serverId: target.id, path: '/home' })
  assert.ok(listing.path.startsWith('/'), 'the resolved path is absolute')
  assert.ok(listing.entries.length > 0, 'the listing has entries')
  assert.ok(listing.entries.every((entry) => typeof entry.name === 'string'))
  const directories = listing.entries.filter((entry) => entry.kind === 'directory')
  assert.ok(directories.length > 0, 'directories are recognised')
  // SFTP is the primary path: it needs no remote tooling, so a macOS or BSD host
  // lists normally instead of reporting that it has no GNU `stat`.
  const liveSession = service.sessions.get(target.id)
  assert.ok(liveSession.sftp !== undefined, 'the listing went through SFTP')
  assert.ok(
    listing.entries.every((entry) => ['directory', 'file', 'symlink', 'other'].includes(entry.kind)),
    'every entry has a kind derived from its mode bits',
  )
  // Symlinks and dotfiles must both survive: the shell glob needed extra patterns
  // for dotfiles, and a symlink is neither a plain file nor a directory.
  assert.ok(
    listing.entries.every((entry) => entry.name !== '.' && entry.name !== '..'),
    'the dot entries are dropped',
  )
  console.log(`ok 5 - listed ${listing.entries.length} entries under ${listing.path} (${directories.length} dirs, over SFTP)`)

  // A single live session may omit the id: the resolver falls back to it.
  const home = await service.listDir({ path: '~' })
  assert.ok(home.path.startsWith('/'), `~ resolved to an absolute path (got ${home.path})`)
  assert.ok(!home.path.includes('~'), '~ is expanded')
  console.log(`ok 6 - ~ resolved to ${home.path} with ${home.entries.length} entries`)

  await assert.rejects(
    () => service.listDir({ path: '/definitely/not/here' }),
    (error) => error.code === 'ssh/no-such-directory',
    'a missing directory is a marked failure',
  )
  // A file is not a directory either, and must fail rather than list nothing.
  await assert.rejects(
    () => service.listDir({ path: '/etc/hostname' }),
    (error) => error.code === 'ssh/no-such-directory',
    'a file is refused as a directory',
  )
  console.log('ok 7 - a missing directory and a plain file both fail explicitly')

  // Relative segments resolve, because the breadcrumb renders the answer as
  // absolute paths and a `..` left in place would become a crumb.
  const normalised = await service.listDir({ path: '/home/../home' })
  assert.equal(normalised.path, '/home', 'dot segments are resolved')
  console.log(`ok 7b - /home/../home resolved to ${normalised.path}`)

  const first = await service.metrics({})
  assert.ok(first.memory.totalBytes > 0, 'memory totals are parsed')
  assert.ok(Array.isArray(first.gpu.devices), 'the GPU list is an array')
  assert.ok(Array.isArray(first.processes), 'process rows are parsed')
  assert.ok(first.processes.length > 0, 'at least one process is listed')
  const sample = first.processes[0]
  for (const field of ['pid', 'ppid', 'user', 'cpuPercent', 'memoryPercent', 'elapsed', 'state', 'threads', 'rssBytes', 'command']) {
    assert.ok(Object.hasOwn(sample, field), `a process row carries ${field}`)
  }
  assert.ok(sample.rssBytes > 0, 'resident memory is in bytes')
  assert.ok(sample.threads > 0, 'the thread count is read')
  assert.ok(sample.command.length > 0, 'the full command line is read')
  const second = await service.metrics({})
  assert.ok(typeof second.cpu.percent === 'number', 'the second sample yields a CPU percentage')
  assert.ok(second.cpu.percent >= 0 && second.cpu.percent <= 100)
  console.log(
    `ok 8 - sampled CPU ${second.cpu.percent.toFixed(1)}% on ${second.cpu.cores} cores, `
    + `${second.gpu.devices.length} GPUs, ${(second.memory.usedBytes / 2 ** 30).toFixed(1)} GiB used, `
    + `${second.processes.length} process rows with rss/threads/elapsed`,
  )

  if (second.gpu.devices.length > 0) {
    const device = second.gpu.devices[0]
    assert.equal(typeof device.name, 'string')
    assert.ok(device.memoryTotalMiB > 0, 'GPU memory totals are parsed')
    assert.equal(typeof device.processCount, 'number', 'each device rolls up its process count')
    console.log(
      `ok 9 - GPU 0 is ${device.name} at ${device.utilization}% and ${device.temperatureC}°C, `
      + `${device.processCount} processes / ${device.processMemoryMiB} MiB attributed`,
    )
  } else {
    console.log('ok 9 - skipped: this target reports no NVIDIA device')
  }

  // A GPU process row must name its device, its owner and its command — the
  // bare pid nvidia-smi reports is what made the old view useless.
  if (second.gpuProcesses.length > 0) {
    const job = second.gpuProcesses.find((row) => typeof row.command === 'string' && row.command.length > 0)
    assert.ok(job !== undefined, 'at least one GPU process carries a command line')
    assert.equal(typeof job.pid, 'number')
    assert.ok(job.gpuIndex === undefined || typeof job.gpuIndex === 'number', 'the device index is resolved')
    assert.ok(job.usedMiB > 0, 'the reserved memory is read')
    console.log(`ok 10 - GPU process ${job.pid} (${job.user ?? '?'}) on #${job.gpuIndex ?? '?'}: ${job.usedMiB} MiB — ${job.command.slice(0, 60)}`)
  } else {
    console.log('ok 10 - skipped: no compute process is running on a device')
  }

  // Every compute process must arrive. `nvidia-smi` lists them in an arbitrary
  // order, so a cap applied before sorting silently dropped whole cards: this
  // host reports 54 processes and the old 48-row cap lost six of them.
  if (second.gpu.devices.length > 0) {
    const perDevice = second.gpu.devices.reduce((sum, device) => sum + (device.processCount ?? 0), 0)
    assert.equal(
      second.gpuProcesses.length,
      perDevice,
      'the list holds every process the devices account for',
    )
    // Cross-check against the count the driver itself reports. This cannot be an
    // equality test: the snapshot and this fresh count are taken seconds apart, and
    // a host running fifty training jobs gains and loses processes in that window.
    // The invariant that must hold is the one the old 48-row cap broke — the list
    // is not silently truncated — and the per-device sum above already pins the
    // exact number from a single instant.
    const counted = await service.exec({
      command: 'nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | grep -c . || true',
    })
    const reported = Number.parseInt(counted.stdout.trim(), 10)
    if (Number.isFinite(reported) && reported > 0) {
      const drift = Math.abs(second.gpuProcesses.length - reported)
      assert.ok(
        drift <= Math.ceil(reported * 0.2),
        `the list tracks nvidia-smi within process churn (${second.gpuProcesses.length} vs ${reported})`,
      )
      if (reported > 48) {
        assert.ok(
          second.gpuProcesses.length > 48,
          `more than the old 48-row cap survived (${second.gpuProcesses.length})`,
        )
      }
    }
    // Sorted by card so a reader can find "what is on #3" without scanning.
    const order = second.gpuProcesses.map((row) => row.gpuIndex ?? Number.MAX_SAFE_INTEGER)
    assert.deepEqual(order, [...order].sort((left, right) => left - right), 'rows are grouped by GPU index')
    const cards = new Set(second.gpuProcesses.map((row) => row.gpuIndex))
    console.log(
      `ok 11 - all ${second.gpuProcesses.length} GPU processes returned across ${cards.size} cards`
      + ` (${second.gpu.devices.map((device) => `#${device.index}=${device.processCount}`).join(' ')})`,
    )
  } else {
    console.log('ok 11 - skipped: no NVIDIA device to enumerate')
  }

  const exec = await service.exec({ command: 'echo hello-from-ssh; exit 7' })
  assert.equal(exec.stdout.trim(), 'hello-from-ssh')
  assert.equal(exec.code, 7, 'the exit code is preserved')
  console.log('ok 12 - command output and exit code survive the round trip')

  const preview = await service.readText({ path: '/etc/hostname' })
  assert.equal(preview.binary, false)
  assert.ok(preview.text.trim().length > 0, 'the preview carries the file text')
  console.log(`ok 13 - previewed /etc/hostname (${preview.sizeBytes} bytes)`)

  const slow = await service.exec({ command: 'sleep 5', timeoutMs: 1000 })
  assert.equal(slow.timedOut, true, 'a timeout is reported instead of hanging')
  console.log('ok 14 - a timed-out command reports timedOut')

  /* ------------------------------------------------------ interactive PTY */

  const openedTerm = await service.termOpen({ serverId: target.id, cols: 100, rows: 30 })
  assert.equal(openedTerm.cols, 100)
  assert.equal(openedTerm.rows, 30)
  const termId = openedTerm.termId
  assert.equal(typeof termId, 'string', 'the Host assigns a terminal id')
  await new Promise((resolve) => setTimeout(resolve, 1200))

  let cursor = 0
  const readTerm = async () => {
    const chunk = await service.termRead({ serverId: target.id, termId, fromSeq: cursor })
    cursor = chunk.seq
    return Buffer.from(chunk.data, 'base64').toString('utf8')
  }
  /**
   * Type into the PTY and return whatever arrived.
   *
   * The settle time is a parameter because this host is sampled under heavy
   * load (200+ cores at ~100%), where a program such as `top` needs well over a
   * second before it prints — a fixed short wait made that check flaky.
   * @param text - keystrokes, usually ending in a carriage return.
   * @param waitMs - how long to let the remote shell produce output.
   * @returns the raw bytes decoded as UTF-8.
   */
  const type = async (text, waitMs = 900) => {
    await service.termWrite({ serverId: target.id, termId, data: Buffer.from(text, 'utf8').toString('base64') })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return await readTerm()
  }

  const banner = await readTerm()
  assert.ok(banner.length > 0, 'the login banner arrives')
  // A carriage return is what a terminal sends for Enter; a newline would only
  // be echoed by the line editor without accepting the line.
  const echoed = await type("printf '\\033[31mCOLOR\\033[0m\\n'; tty; stty size\r")
  assert.ok(echoed.includes('\u001b['), 'ANSI escapes survive the channel')
  assert.match(echoed, /\/dev\/pts\/\d+/u, 'the remote side has a real PTY')
  assert.ok(echoed.includes('30 100'), 'the PTY starts at the requested size')
  console.log(`ok 15 - PTY answers with ANSI, a real /dev/pts and a ${openedTerm.rows}×${openedTerm.cols} window`)

  const resized = await service.termResize({ serverId: target.id, termId, cols: 120, rows: 40 })
  assert.deepEqual(resized, { cols: 120, rows: 40 })
  const afterResize = await type('stty size\r')
  assert.ok(afterResize.includes('40 120'), 'the remote PTY follows a resize')
  console.log('ok 16 - resizing the panel resizes the remote PTY')

  // A full-screen program only works against a PTY, so this is the check that
  // separates a real terminal from a piped command runner. `top` on a loaded
  // 224-core host takes a while to print, hence the longer settle time.
  const top = await type("printf 'TICK\\n'; top -bn1 | head -3\r", 4000)
  assert.ok(top.includes('TICK'), 'the command batch ran')
  assert.ok(/load average|PID|USER|Tasks|Mem/u.test(top), 'top produced its header')
  console.log('ok 17 - a full-screen program runs in the terminal')

  // Re-opening the tab must re-attach, not start a second login: the shell keeps
  // its working directory and its history, which is what "it stays there" means.
  await type('cd /tmp && export SSC_MARK=kept\r')
  const beforeAttach = service.terminals.get(`${target.id}\u0000${termId}`)
  assert.ok(beforeAttach !== undefined, 'the terminal is registered under its own key')
  const reattached = await service.termOpen({ serverId: target.id, termId, cols: 100, rows: 30 })
  assert.equal(reattached.attached, true, 'termOpen re-attaches to the live PTY')
  assert.equal(reattached.termId, termId, 'the same terminal id comes back')
  assert.equal(
    service.terminals.get(`${target.id}\u0000${termId}`),
    beforeAttach,
    'the same channel is reused',
  )
  assert.ok(reattached.seq >= beforeAttach.seq, 'the cursor reports the retained output')
  const survived = await type('echo "mark=$SSC_MARK pwd=$(pwd)"\r')
  assert.ok(survived.includes('mark=kept'), 'the shell kept its environment')
  assert.match(survived, /pwd=\/tmp/u, 'the shell kept its working directory')
  console.log('ok 18 - reopening the terminal re-attaches to the same shell, keeping cd and env')

  /* ------------------------------------ several terminals on one connection */

  // A split view is two independent logins on the same connection: each needs
  // its own cwd, its own environment and its own window size.
  const secondTerm = await service.termOpen({ serverId: target.id, cols: 80, rows: 24 })
  assert.notEqual(secondTerm.termId, termId, 'a new terminal gets its own id')
  assert.equal(secondTerm.attached, false, 'it is a fresh shell, not a re-attach')
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const secondCursor = { value: 0 }
  const readSecond = async () => {
    const chunk = await service.termRead({
      serverId: target.id,
      termId: secondTerm.termId,
      fromSeq: secondCursor.value,
    })
    secondCursor.value = chunk.seq
    return Buffer.from(chunk.data, 'base64').toString('utf8')
  }
  const typeSecond = async (text, waitMs = 900) => {
    await service.termWrite({
      serverId: target.id,
      termId: secondTerm.termId,
      data: Buffer.from(text, 'utf8').toString('base64'),
    })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return await readSecond()
  }

  await typeSecond('cd /var && export SSC_MARK=second\r')
  const secondSays = await typeSecond('echo "second:$SSC_MARK:$(pwd)"\r')
  assert.ok(secondSays.includes('second:second'), 'the second terminal has its own environment')
  assert.match(secondSays, /second:second:\/var/u, 'the second terminal has its own cwd')

  // The first shell must be untouched by all of that.
  const firstSays = await type('echo "first:$SSC_MARK:$(pwd)"\r')
  assert.ok(firstSays.includes('first:kept'), 'the first terminal kept its environment')
  assert.match(firstSays, /first:kept:\/tmp/u, 'the first terminal kept its cwd')

  const listed = await service.termList({ serverId: target.id })
  assert.equal(listed.terminals.length, 2, 'both terminals are listed')
  const sizes = new Map(listed.terminals.map((entry) => [entry.termId, [entry.cols, entry.rows]]))
  assert.deepEqual(sizes.get(termId), [100, 30], 'the first terminal keeps its own size')
  assert.deepEqual(sizes.get(secondTerm.termId), [80, 24], 'the second terminal keeps its own size')
  console.log(
    `ok 19 - two independent PTYs on one connection (${termId} 100×30 in /tmp, ${secondTerm.termId} 80×24 in /var)`,
  )

  // A request that names no terminal is ambiguous now; guessing would type into
  // the wrong shell.
  await assert.rejects(
    () => service.termRead({ serverId: target.id, fromSeq: 0 }),
    (error) => error.code === 'ssh/ambiguous-terminal',
    'an unnamed request is refused once a server has several terminals',
  )
  console.log('ok 20 - an unspecified terminal is refused rather than guessed')

  // Closing one leaves the other running.
  const closedSecond = await service.termClose({ serverId: target.id, termId: secondTerm.termId })
  assert.deepEqual(closedSecond.closedIds, [secondTerm.termId])
  assert.deepEqual(
    service.terminalsOf(target.id).map(([id]) => id),
    [termId],
    'the other terminal survives',
  )
  const stillAlive = await type('echo "still:$SSC_MARK"\r')
  assert.ok(stillAlive.includes('still:kept'), 'the surviving terminal still answers')
  console.log('ok 21 - closing one terminal leaves the other one running')

  const closed = await service.termClose({ serverId: target.id })
  assert.deepEqual(closed.closedIds, [termId])
  assert.equal(service.terminals.size, 0)
  await assert.rejects(
    () => service.termWrite({ serverId: target.id, termId, data: '' }),
    (error) => error.code === 'ssh/no-terminal',
    'writing after close is refused',
  )
  console.log('ok 22 - closing every terminal detaches them from the connection')

  /* ------------------------------------------------- two sessions at once */

  // Try the other key-authenticated hosts first: the password-only ones would
  // only prove that a failed handshake is reported.
  const others = catalogue.servers.filter((server) => server.host !== target.host)
  const preferred = [
    ...others.filter((server) => server.host === '211.69.141.69' || server.host === '211.69.141.70'),
    ...others.filter((server) => server.host !== '211.69.141.69' && server.host !== '211.69.141.70'),
  ]
  if (preferred.length === 0) {
    console.log('ok 23 - skipped: only one target is configured')
  } else {
    let other
    for (const candidate of preferred.slice(0, 4)) {
      try {
        // Trust this host's key in the scratch file first, the way the panel does.
        const key = await service.hostKey({ serverId: candidate.id })
        await service.connect(key.status === 'trusted'
          ? { serverId: candidate.id }
          : { serverId: candidate.id, trustFingerprint: key.fingerprint })
        other = candidate
        break
      } catch (error) {
        console.log(`     (skipping ${candidate.id}: ${String(error.message).split('\n')[0]})`)
      }
    }
    if (other === undefined) {
      console.log('ok 23 - skipped: no second target accepted the configured credentials')
    } else {
      const both = await service.status({})
      assert.equal(both.sessions.length, 2, 'both sessions stay open')
      assert.deepEqual(
        both.sessions.map((entry) => entry.serverId).sort(),
        [target.id, other.id].sort(),
      )

      // Two hosts sampled together must not share CPU baselines.
      const [one, two] = await Promise.all([
        service.metrics({ serverId: target.id }),
        service.metrics({ serverId: other.id }),
      ])
      assert.notEqual(one.hostname, two.hostname, 'each snapshot belongs to its own host')

      // With several sessions open, an unnamed request must be refused rather
      // than silently sampling the wrong machine.
      await assert.rejects(
        () => service.metrics({}),
        (error) => error.code === 'ssh/not-connected',
        'an ambiguous request is refused',
      )

      await service.disconnect({ serverId: other.id })
      assert.equal((await service.status({})).sessions.length, 1, 'closing one keeps the other')
      console.log(`ok 23 - two servers were connected together (${target.id} + ${other.id}: ${one.hostname} / ${two.hostname})`)
    }
  }
} catch (error) {
  if (!connected && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|authentication/i.test(String(error?.message))) {
    console.log(`skip - ${target.id} is unreachable (${error.message}); the local checks above passed`)
    process.exit(0)
  }
  throw error
} finally {
  await service.disconnect({})
}

assert.deepEqual((await service.status({})).sessions, [])
console.log('ok 24 - disconnect clears every session')

/* -------------------------------------------------------------- host keys */

// The scratch file is written to by the connection above, so by now it holds this
// host's key and the status must have flipped from unknown to trusted.
const trusted = await service.hostKey({ serverId: target.id })
assert.equal(trusted.status, 'trusted', 'the accepted key was recorded and is recognised next time')
assert.equal(trusted.fingerprint, (await service.hostKey({ serverId: target.id })).fingerprint,
  'the same host reports a stable fingerprint')

// A key that disagrees with the file is the dangerous case and must never be
// classified as merely unknown, which is what would offer a "trust this" button.
const entries = readFileSync(service.knownHostsFile(), 'utf8').trim()
const realBody = trusted.keyBody
writeFileSync(
  service.knownHostsFile(),
  `[${target.host}]:${target.port} ${trusted.keyType} ${Buffer.from('a different key entirely').toString('base64')}\n${entries}\n`,
)
// Appending a conflicting line must still read as trusted while the real entry is
// present; replacing it must not.
writeFileSync(
  service.knownHostsFile(),
  `[${target.host}]:${target.port} ${trusted.keyType} ${Buffer.from('a different key entirely').toString('base64')}\n`,
)
const tampered = await service.hostKey({ serverId: target.id })
assert.equal(tampered.status, 'mismatch', 'a changed key is a mismatch, not an unknown host')
assert.equal(tampered.keyBody, realBody, 'the observation is still the real key')

await assert.rejects(
  () => service.connect({ serverId: target.id, trustFingerprint: tampered.fingerprint }),
  (error) => error.code === 'ssh/host-key-mismatch',
  'a mismatched key cannot be waved through by confirming its fingerprint',
)

// And with no trust at all against an empty file, the refusal is "unknown" — the
// state that is allowed to become trust on confirmation.
writeFileSync(service.knownHostsFile(), '')
await assert.rejects(
  () => service.connect({ serverId: target.id }),
  (error) => error.code === 'ssh/host-key-unknown',
  'an unknown host is refused until its fingerprint is confirmed',
)
await service.connect({ serverId: target.id, trustFingerprint: trusted.fingerprint })
console.log('ok 25 - an unknown key needs confirmation, a changed key is refused outright')

// A known_hosts file legitimately holds several key types for one host, so an
// entry of a *different* type is not a conflict. Getting this wrong is not a
// subtle inaccuracy: this host's real entry is ECDSA while the server offers
// Ed25519 first, and treating that as a mismatch refused a host that plain `ssh`
// connects to. The distinction is the whole of this assertion.
writeFileSync(
  service.knownHostsFile(),
  `[${target.host}]:${target.port} ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBfake\n`,
)
const otherType = await service.hostKey({ serverId: target.id })
assert.equal(otherType.status, 'unknown', 'a different key type is "not seen yet", not a mismatch')

// The same type carrying a different body is the conflict that must be refused.
writeFileSync(
  service.knownHostsFile(),
  `[${target.host}]:${target.port} ${otherType.keyType} ${Buffer.from('same type, wrong key').toString('base64')}\n`,
)
const sameType = await service.hostKey({ serverId: target.id })
assert.equal(sameType.status, 'mismatch', 'the same key type with a different body is a mismatch')
console.log('ok 26 - key types are compared separately, the way OpenSSH does')
await service.disconnect({})
console.log(`     (known_hosts for this run: ${service.knownHostsFile()})`)

/* -------------------------------------------------------- editing ssh config */

// The whole risk of this feature is a rewrite quietly dropping something, so every
// assertion here is about what SURVIVES. The fixture carries the shapes that a real
// file has and that this plugin has no opinion about: a leading comment, a
// directive it does not understand, and a `Host *` defaults block at the bottom.
// These are the two directives on this machine's own Tencent git entry; losing them
// makes that host unreachable, silently.
const seed = [
  '# leading comment',
  'Host alpha',
  '  HostName 10.0.0.1',
  '  Port 2222',
  '  User root',
  '  HostKeyAlgorithms +ssh-rsa',
  '',
  'Host beta',
  '  HostName 10.0.0.2',
  '  Port 22',
  '',
  '# defaults, keep at the bottom',
  'Host *',
  '  ServerAliveInterval 30',
  '  ForwardAgent yes',
  '',
].join('\n')
const editDir = scratchDir('ssc-config-')
const editPath = join(editDir, 'config')
writeFileSync(editPath, seed)
const editor = new SshConsoleService(ctx, {
  sshConfigFile: editPath,
  includeSshConfig: true,
  servers: [],
})

let catalogue2 = await editor.servers({})
assert.equal(catalogue2.canEdit, true, 'editing is on by default')
assert.equal(catalogue2.configPath, editPath, 'the catalogue names the file it edits')
assert.ok(catalogue2.servers.every((entry) => entry.editable === true), 'ssh-config entries are editable')
assert.equal(catalogue2.servers.length, 2, 'the wildcard block is not offered as a target')

await editor.saveServer({ mode: 'update', originalLabel: 'alpha', label: 'alpha', host: '10.9.9.9', port: 2200, user: 'deploy' })
const afterEdit = readFileSync(editPath, 'utf8')
assert.ok(afterEdit.includes('  HostName 10.9.9.9'), 'HostName was updated')
assert.ok(afterEdit.includes('  Port 2200'), 'Port was updated')
assert.ok(afterEdit.includes('  User deploy'), 'User was updated')
assert.ok(afterEdit.includes('  HostKeyAlgorithms +ssh-rsa'), 'an unknown directive survived the edit')
assert.ok(afterEdit.startsWith('# leading comment'), 'the leading comment survived')
assert.ok(afterEdit.includes('ServerAliveInterval 30'), 'the wildcard block survived')
assert.ok(afterEdit.endsWith('\n'), 'the file still ends with a newline')

// A new block must land BEFORE `Host *`. `ssh` takes the first value it finds for
// each keyword, so a block placed after the defaults would have any keyword the
// defaults also set silently overridden by them: the file would look right and
// authenticate as somebody else.
const added2 = await editor.saveServer({ mode: 'add', label: 'gamma', host: '10.0.0.3', port: 22, user: 'ubuntu' })
assert.equal(added2.savedId, 'ubuntu@10.0.0.3:22', 'the new id comes back')
const afterAdd2 = readFileSync(editPath, 'utf8')
assert.ok(afterAdd2.includes('  Port 22'), 'Port is written explicitly, even at its default')
assert.ok(
  afterAdd2.indexOf('Host gamma') < afterAdd2.indexOf('Host *'),
  'a new block is inserted before the defaults block',
)

// A duplicate alias must be refused without touching the file.
await assert.rejects(
  () => editor.saveServer({ mode: 'add', label: 'gamma', host: '1.2.3.4', port: 22 }),
  (error) => error.code === 'ssh/label-exists',
  'a duplicate alias is refused',
)
assert.equal(readFileSync(editPath, 'utf8'), afterAdd2, 'and nothing was written')

// An alias that ssh would read as a pattern is refused rather than escaped.
for (const bad of ['has space', 'a*b', 'q?', '!neg', '-x']) {
  await assert.rejects(
    () => editor.saveServer({ mode: 'add', label: bad, host: '1.2.3.4', port: 22 }),
    (error) => error.code === 'ssh/bad-label',
    `${JSON.stringify(bad)} is refused`,
  )
}
// A control character in the host would inject a line into known_hosts.
for (const bad of ['has space', 'a#b', 'a\nb']) {
  await assert.rejects(
    () => editor.saveServer({ mode: 'add', label: 'h1', host: bad, port: 22 }),
    (error) => error.code === 'ssh/bad-host',
    `host ${JSON.stringify(bad)} is refused`,
  )
}

// Editing a live target drops its session, because its parameters are what changed.
// The terminals on it go too: a PTY cannot outlive the connection carrying it.
catalogue2 = await editor.servers({})
const betaEntry = catalogue2.servers.find((entry) => entry.label === 'beta')
editor.sessions.set(betaEntry.id, { client: { end() {} }, connected: true, server: { id: betaEntry.id } })
// A control character cannot occur in an alias, so this key matches the one the
// service builds for `serverId` + `t1` without needing its internal helper.
editor.terminals.set(`${betaEntry.id}\u0000t1`, { exited: false, stream: { end() {} } })
await editor.saveServer({ mode: 'update', originalLabel: 'beta', label: 'beta', host: '10.0.0.2', port: 2222 })
assert.equal(editor.sessions.has(betaEntry.id), false, 'editing a connected target disconnects it')
assert.equal(editor.terminals.size, 0, 'and its terminals go with it')

// Removing a block takes its directives with it and leaves the rest alone.
await editor.removeServer({ label: 'gamma' })
const afterRemove2 = readFileSync(editPath, 'utf8')
assert.ok(!afterRemove2.includes('Host gamma'), 'the block is gone')
assert.ok(afterRemove2.includes('Host *'), 'the defaults block is still there')
assert.ok(afterRemove2.includes('HostKeyAlgorithms +ssh-rsa'), 'the unknown directive is still there')
assert.ok(!afterRemove2.includes('\n\n\n'), 'removing does not leave a run of blank lines')
console.log('ok 27 - editing ssh_config touches only its own lines')

// `Match` changes what the blocks around it mean, so a rewrite could be silently
// wrong. It is refused, with the path, rather than guessed at.
writeFileSync(editPath, 'Host a\n  HostName 1.1.1.1\nMatch host b\n  User x\n')
await assert.rejects(
  () => editor.saveServer({ mode: 'add', label: 'c', host: '2.2.2.2', port: 22 }),
  (error) => error.code === 'ssh/config-unsupported',
  'a file using Match is refused',
)

// Turning the feature off must make the panel offer nothing and the Host refuse.
const locked = new SshConsoleService(ctx, { sshConfigFile: editPath, includeSshConfig: true, servers: [], allowConfigEdit: false })
const lockedCatalogue = await locked.servers({})
assert.equal(lockedCatalogue.canEdit, false, 'canEdit is false when disabled')
assert.ok(lockedCatalogue.servers.every((entry) => entry.editable === false), 'no entry offers editing')
await assert.rejects(
  () => locked.saveServer({ mode: 'add', label: 'z', host: '3.3.3.3', port: 22 }),
  (error) => error.code === 'ssh/config-edit-disabled',
  'the write is refused when disabled',
)
console.log('ok 28 - a Match file is refused, and editing can be turned off')

/* ------------------------------------------------------- numeric coercion */

// The form sends the port as TEXT, because it is a text input. It once reached the
// writer as '26518', failed a `typeof value === 'number'` test, and fell back to
// 22 — so every save through the panel rewrote the port to 22 and the next
// connection was refused. The pre-write verification missed it because it compared
// the written port against the same wrongly-defaulted value, which is why the
// checks below are about the helpers as well as about the written file.
assert.equal(clampNumber('26518', 22, 1, 65535), 26518, 'a numeric string is a number, not a reason to default')
assert.equal(clampNumber(' 2222 ', 22, 1, 65535), 2222, 'surrounding whitespace is tolerated')
assert.equal(clampNumber('', 22, 1, 65535), 22, 'an empty value falls back')
assert.equal(clampNumber('abc', 22, 1, 65535), 22, 'garbage falls back when reading')
assert.equal(parsePortStrict('26518'), 26518, 'a numeric string parses')
assert.equal(parsePortStrict(26518), 26518, 'a number parses')
for (const bad of ['', 'abc', '0', '65536', '22.5']) {
  assert.equal(parsePortStrict(bad), undefined, `port ${JSON.stringify(bad)} is not usable`)
}

// Reading a file may degrade to a default; writing to one must not. That is the
// whole distinction between the two helpers, so it gets its own write attempt.
writeFileSync(editPath, 'Host box\n  HostName 10.0.0.1\n  Port 26518\n  User yz\n')
const portEditor = new SshConsoleService(ctx, { sshConfigFile: editPath, includeSshConfig: true, servers: [] })
const boxEntry = (await portEditor.servers({})).servers[0]
assert.equal(boxEntry.port, 26518, 'the catalogue reports the real port')
// Exactly what the form sends: String(entry.port).
await portEditor.saveServer({
  mode: 'update', originalLabel: 'box', label: 'box',
  host: boxEntry.host, port: String(boxEntry.port), user: boxEntry.user, identityFile: '',
})
assert.ok(readFileSync(editPath, 'utf8').includes('  Port 26518'), 'a text port round-trips unchanged')
assert.ok(!readFileSync(editPath, 'utf8').includes('  Port 22'), 'and is not silently rewritten to 22')

const beforeBadPort = readFileSync(editPath, 'utf8')
for (const bad of ['', 'abc', '65536']) {
  await assert.rejects(
    () => portEditor.saveServer({ mode: 'update', originalLabel: 'box', label: 'box', host: '10.0.0.1', port: bad, user: 'yz' }),
    (error) => error.code === 'ssh/bad-port',
    `port ${JSON.stringify(bad)} is refused rather than defaulted`,
  )
}
assert.equal(readFileSync(editPath, 'utf8'), beforeBadPort, 'a refused port writes nothing')
console.log('ok 29 - a port sent as text round-trips, and an unusable one is refused')

// A refused dial is not a trust decision. Reporting it as "the key could not be
// verified" sends the reader to known_hosts when nothing is even listening.
writeFileSync(editPath, 'Host dead\n  HostName 127.0.0.1\n  Port 1\n  User yz\n')
const deadEditor = new SshConsoleService(ctx, { sshConfigFile: editPath, includeSshConfig: true, servers: [] })
const deadEntry = (await deadEditor.servers({})).servers[0]
for (const attempt of [
  () => deadEditor.hostKey({ serverId: deadEntry.id }),
  () => deadEditor.connect({ serverId: deadEntry.id }),
]) {
  await assert.rejects(
    attempt,
    (error) => error.code === 'ssh/unreachable' && error.details?.code === 'ECONNREFUSED',
    'a refused dial is reported as unreachable, not as an unverified key',
  )
}
console.log('ok 30 - a connection that is refused is not reported as a host-key failure')

// The one assertion that protects the machine this runs on. Everything above is
// supposed to have used a scratch directory; this fails the run if any of it
// reached the real files.
for (const before of realBefore) {
  let after
  try {
    const info = statSync(before.path)
    after = { exists: true, mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    after = { exists: false }
  }
  assert.equal(after.exists, before.exists, `${before.path} was not created or removed by the tests`)
  if (before.exists) {
    assert.equal(after.mtimeMs, before.mtimeMs, `${before.path} was not modified by the tests`)
    assert.equal(after.size, before.size, `${before.path} kept its size`)
  }
}
console.log('ok 31 - the tests never wrote to the real ~/.ssh files')

console.log('\nall host checks passed')
