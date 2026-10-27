/**
 * Host-half harness: drives the real service against a real server.
 *
 * Run: node test/host.test.mjs [hostId]
 * The network part is skipped when the target cannot be reached, so the file
 * stays runnable on a machine without the lab servers.
 */
import assert from 'node:assert/strict'
import { SshConsoleService } from '../index.js'

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
const service = new SshConsoleService(ctx, { refreshMs: 2000 })
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
  const session = await service.connect({ serverId: target.id })
  connected = true
  assert.equal(session.server.host, target.host)
  assert.ok(session.hostname.length > 0, 'the remote hostname is known')
  console.log(`ok 3 - connected to ${target.id} as ${session.hostname} (${session.os})`)

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
  console.log(`ok 5 - listed ${listing.entries.length} entries under ${listing.path} (${directories.length} dirs)`)

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
  console.log('ok 7 - a missing directory fails explicitly')

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
    // Cross-check against the count the driver itself reports, gathered the same
    // way the plugin gathers it.
    const counted = await service.exec({
      command: 'nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | grep -c . || true',
    })
    const reported = Number.parseInt(counted.stdout.trim(), 10)
    if (Number.isFinite(reported) && reported > 0) {
      assert.equal(
        second.gpuProcesses.length,
        reported,
        `all ${reported} processes reported by nvidia-smi survive the round trip`,
      )
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
        await service.connect({ serverId: candidate.id })
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

console.log('\nall host checks passed')
