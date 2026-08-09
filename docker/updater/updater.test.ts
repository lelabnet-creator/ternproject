import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The updater, driven against a Docker that is not Docker.
 *
 * This script is the one piece of TERN that runs as root on the host, and the
 * only piece nothing else can exercise: by the time it does its last useful
 * thing, the process that asked for it has been replaced. So it is run here for
 * real — a real `/bin/sh`, the real file, the real polling loop — with a stub
 * on `PATH` that answers like `docker` and records what it was asked to do.
 *
 * What that buys is the answer to the question that matters: when something
 * goes wrong, does it stop, and does it say so? A pull that fails must not go
 * on to recreate anything, and an image whose label disagrees with its tag must
 * never reach the `.env` file.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'updater.sh')

let root: string
let dataDir: string
let deployDir: string
let binDir: string
let child: ReturnType<typeof spawn> | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tern-updater-'))
  dataDir = join(root, 'data')
  deployDir = join(root, 'deploy')
  binDir = join(root, 'bin')
  for (const dir of [dataDir, deployDir, binDir]) mkdirSync(dir, { recursive: true })

  writeFileSync(join(deployDir, 'docker-compose.prod.yml'), 'name: tern-prod\n')
  writeFileSync(join(deployDir, '.env'), 'TERN_IMAGE=ghcr.io/owner/tern:0.1.6\nOTHER=keep-me\n')
})

afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  rmSync(root, { recursive: true, force: true })
})

/**
 * A `docker` that behaves as asked.
 *
 * `pull` prints the lines a real one prints with no TTY — the announcement of
 * each layer and its completion, which is exactly what the progress count reads.
 */
function stubDocker({
  layers = 3,
  pullFails = false,
  label = '',
}: { layers?: number; pullFails?: boolean; label?: string } = {}) {
  const calls = join(root, 'docker-calls.log')

  const script = `#!/bin/sh
echo "$@" >> ${JSON.stringify(calls)}
case "$1" in
  pull)
    ${Array.from({ length: layers }, (_, i) => `echo "layer${i}: Pulling fs layer"`).join('\n    ')}
    ${Array.from({ length: layers }, (_, i) => `echo "layer${i}: Pull complete"`).join('\n    ')}
    ${pullFails ? 'echo "failed to register layer: no space left on device" >&2; exit 1' : 'echo "Status: Downloaded newer image"'}
    ;;
  image)
    printf '%s\\n' ${JSON.stringify(label)}
    ;;
  compose)
    echo "Recreating app"
    ;;
esac
exit 0
`
  writeFileSync(join(binDir, 'docker'), script, { mode: 0o755 })
  return () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')
}

function start() {
  child = spawn('/bin/sh', [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TERN_DATA_DIR: dataDir,
      TERN_DEPLOY_DIR: deployDir,
      TERN_UPDATER_POLL_S: '1',
    },
    stdio: 'ignore',
  })
}

function request(fields: Record<string, string>) {
  writeFileSync(
    join(dataDir, 'update.request'),
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  )
}

function readStatus(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'update.status.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

/** Polls until `predicate` holds, or gives up — a hang here is a real failure. */
async function until(predicate: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`gave up waiting; last status was ${JSON.stringify(readStatus())}`)
}

const settled = () => {
  const state = readStatus()?.state
  return state === 'succeeded' || state === 'failed'
}

describe.skipIf(process.platform === 'win32')('the updater script', () => {
  it('announces itself, so the admin knows there is something to press', async () => {
    stubDocker()
    start()

    await until(() => existsSync(join(dataDir, 'updater.json')))
    const beat = JSON.parse(readFileSync(join(dataDir, 'updater.json'), 'utf8')) as {
      seenAt: string
    }
    expect(Number.isNaN(Date.parse(beat.seenAt))).toBe(false)
  }, 30_000)

  it('pulls, verifies, records the tag and recreates the instance', async () => {
    const calls = stubDocker({ layers: 4, label: 'v0.1.7' })
    start()
    request({ id: 'job-00000001', target: '0.1.7', image: 'ghcr.io/owner/tern' })

    await until(settled)

    expect(readStatus()).toMatchObject({ state: 'succeeded', step: 'restart', target: '0.1.7' })

    const log = calls()
    expect(log).toContain('pull ghcr.io/owner/tern:0.1.7')
    expect(log).toContain('up -d app agent')

    // The tag has to survive the next `docker compose up -d` somebody types by
    // hand, and nothing else in the file may be disturbed doing it.
    const env = readFileSync(join(deployDir, '.env'), 'utf8')
    expect(env).toContain('TERN_IMAGE=ghcr.io/owner/tern:0.1.7')
    expect(env).toContain('OTHER=keep-me')
  }, 30_000)

  it('reports progress while the layers land', async () => {
    stubDocker({ layers: 3, label: 'v0.1.7' })
    start()
    request({ id: 'job-00000002', target: '0.1.7', image: 'ghcr.io/owner/tern' })

    await until(settled)
    // The final report is the one that must be right; the intermediate ones are
    // sampled on a timer this test cannot race reliably.
    expect(readStatus()).toMatchObject({ percent: 100 })
  }, 30_000)

  it('stops at a pull that failed, and says why', async () => {
    const calls = stubDocker({ pullFails: true })
    start()
    request({ id: 'job-00000003', target: '0.1.7', image: 'ghcr.io/owner/tern' })

    await until(settled)

    const status = readStatus()
    expect(status).toMatchObject({ state: 'failed', step: 'pull' })
    expect(String(status?.detail)).toContain('no space left on device')
    // Nothing recreated, and the running tag untouched.
    expect(calls()).not.toContain('up -d')
    expect(readFileSync(join(deployDir, '.env'), 'utf8')).toContain('tern:0.1.6')
  }, 30_000)

  it('refuses an image whose own label disagrees with the tag that fetched it', async () => {
    // A registry tag is mutable. This is the one case where carrying on would
    // install something nobody chose.
    const calls = stubDocker({ label: 'v0.1.5' })
    start()
    request({ id: 'job-00000004', target: '0.1.7', image: 'ghcr.io/owner/tern' })

    await until(settled)

    expect(readStatus()).toMatchObject({ state: 'failed', step: 'verify' })
    expect(String(readStatus()?.detail)).toContain('0.1.5')
    expect(calls()).not.toContain('up -d')
  }, 30_000)

  it('refuses an image with no version label at all', async () => {
    stubDocker({ label: '' })
    start()
    request({ id: 'job-00000005', target: '0.1.7', image: 'ghcr.io/owner/tern' })

    await until(settled)
    expect(readStatus()).toMatchObject({ state: 'failed', step: 'verify' })
  }, 30_000)

  it('refuses a target that is not a release version', async () => {
    // `latest` moves. Whatever else this does, it does not run a moving tag.
    const calls = stubDocker({ label: 'v0.1.7' })
    start()
    request({ id: 'job-00000006', target: 'latest', image: 'ghcr.io/owner/tern' })

    await until(settled)
    expect(readStatus()).toMatchObject({ state: 'failed' })
    expect(calls()).not.toContain('pull')
  }, 30_000)

  it('refuses an image name that is not one', async () => {
    // The request arrives in a file, and a file is not the API. Whatever wrote
    // it, these values are about to be arguments to a command.
    const calls = stubDocker({ label: 'v0.1.7' })
    start()
    request({
      id: 'job-00000007',
      target: '0.1.7',
      image: 'ghcr.io/owner/tern; touch /tmp/tern-pwned',
    })

    await until(settled)
    expect(readStatus()).toMatchObject({ state: 'failed' })
    expect(calls()).not.toContain('pull')
  }, 30_000)

  it('runs a request once, however long it sits there', async () => {
    // The request file stays in the volume after the update. Acting on it again
    // on the next tick would be a restart loop.
    const calls = stubDocker({ label: 'v0.1.7' })
    start()
    request({ id: 'job-00000008', target: '0.1.7', image: 'ghcr.io/owner/tern' })

    await until(settled)
    await new Promise((resolve) => setTimeout(resolve, 3000))

    expect(
      calls()
        .split('\n')
        .filter((line) => line.startsWith('pull ')).length,
    ).toBe(1)
  }, 30_000)
})
