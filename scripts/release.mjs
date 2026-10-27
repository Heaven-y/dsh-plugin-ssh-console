#!/usr/bin/env node
/**
 * Cut one release and put it on both channels with a single command.
 *
 * GitHub already holds the code, so the release is the tag: pushing a `v*` tag
 * is what wakes the Publish workflow, which ships the same commit to npm and
 * then creates the GitHub release for that tag. There is deliberately no second
 * step to forget.
 *
 * Authentication lives entirely in CI (a token secret, or OIDC once trusted
 * publishing is configured), so this script never handles a credential.
 *
 * Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const target = args.find((value) => !value.startsWith('--'))

/**
 * The npm command as `[executable, prefixArgs]`. On Windows `npm` is a `.cmd`
 * shim, which `execFile` refuses to spawn without a shell — so run npm's own
 * JavaScript entry through the current Node binary instead. That is exactly what
 * the shim does, minus the shell quoting.
 * @returns the launch pair.
 */
function npmCommand() {
  if (process.platform !== 'win32') return ['npm', []]
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(cli) ? [process.execPath, [cli]] : ['npm.cmd', []]
}

const [NPM, NPM_PREFIX] = npmCommand()

/** Run a command in the repository root, returning its stdout. */
function run(command, argv, { allowFailure = false } = {}) {
  try {
    return execFileSync(command, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    if (allowFailure) return undefined
    const detail = error.stderr?.trim() || error.message
    console.error(`\n${command} ${argv.join(' ')} failed:\n${detail}\n`)
    process.exit(1)
  }
}

if (target === undefined) {
  console.error('Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]')
  process.exit(1)
}

// A release must start from a tree that is exactly what was reviewed and tested.
const dirty = run('git', ['status', '--porcelain'])
if (dirty !== '') {
  console.error('The working tree has uncommitted changes. Commit or stash them first:\n')
  console.error(dirty)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const current = manifest.version
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') {
  console.error(`Releases are cut from main; this checkout is on "${branch}".`)
  process.exit(1)
}

// The suites are the gate: a tag that ships untested code cannot be recalled
// from npm, only deprecated.
console.log(`current version: ${current}`)
console.log('running the suites before tagging...')
run('node', ['test/host.test.mjs'])
run('node', ['test/client.test.mjs'])
run('node', ['test/panes.test.mjs'])
console.log('tests passed')

if (dryRun) {
  console.log(`\n--dry-run: would bump ${target}, tag v<next>, and push to origin.`)
  process.exit(0)
}

// `npm version` bumps the manifest, commits it and creates the annotated tag in
// one step, so the tag can never point at a tree with a stale version.
const tagged = run(NPM, [...NPM_PREFIX, 'version', target, '-m', 'chore(release): v%s'])
console.log(`tagged: ${tagged}`)
run('git', ['push', 'origin', 'HEAD', '--follow-tags'])
console.log('\npushed. The Publish workflow now ships this commit to npm and opens the GitHub release.')

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
console.log(`\nfollow the run: gh run list --workflow=publish.yml   (or the Actions tab)`)
console.log(`once green:     npm view ${manifest.name}@${version} version`)
