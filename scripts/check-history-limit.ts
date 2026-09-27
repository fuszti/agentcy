// Post >10k messages to a scratch channel and verify the oldest post is still reachable.
// Verdict: Mattermost Team Edition does NOT enforce a 10k message cap.

import { spawn } from 'node:child_process'
import { MattermostClient } from '../src/lib/mattermost.js'
import { loadConfig, loadSecrets } from '../src/lib/config.js'

const TOTAL = 10_050
const CONCURRENCY = 10

function dockerExec(container: string, command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn('docker', ['exec', container, ...command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    cp.stdout?.on('data', (d) => (out += d.toString()))
    cp.stderr?.on('data', (d) => (err += d.toString()))
    cp.on('close', (code) => {
      if (code !== 0) reject(new Error(`docker exec failed: ${err || out || code}`))
      else resolve(out)
    })
    cp.on('error', reject)
  })
}

async function pool<T>(items: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = []
  let index = 0
  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await items[i]()
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

async function main() {
  const config = await loadConfig()
  const secrets = await loadSecrets()
  if (!secrets) throw new Error('bootstrap must be run first')

  const mm = new MattermostClient(config.mattermostUrl, secrets.mattermost.adminToken)
  const team = await mm.getTeamByName(config.team)

  // Remove any leftover scratch channel from a previous run.
  try {
    await dockerExec('agent-office-mattermost', ['mmctl', '--local', 'channel', 'delete', '--confirm', `${config.team}:zz-history-test`])
  } catch {
    // ignore if it did not exist
  }

  const channel = await mm.createChannel({
    teamId: team.id,
    name: 'zz-history-test',
    displayName: 'zz-history-test',
    purpose: 'Temporary channel for history-limit probe',
    type: 'O',
  })

  const timings = {
    postStart: Date.now(),
    postEnd: 0,
    firstById: 0,
    firstByPage: 0,
    firstBySearch: 0,
  }

  console.log(`Posting ${TOTAL} messages to #${channel.name} with concurrency ${CONCURRENCY}...`)
  const postCalls = Array.from({ length: TOTAL }, (_, i) => async () => {
    const post = await mm.createPost({ channelId: channel.id, message: `history probe ${String(i).padStart(6, '0')}` })
    return post
  })
  const posts = await pool(postCalls, CONCURRENCY)
  timings.postEnd = Date.now()

  // Use the chronologically earliest post as "first" (concurrent submission order != create order).
  const firstPost = posts.reduce((earliest, p) => (p.createAt < earliest.createAt ? p : earliest), posts[0])
  if (!firstPost) throw new Error('no first post')

  console.log(`First post id: ${firstPost.id}`)

  // 1. Direct retrieval by id.
  const t0 = Date.now()
  const byId = await mm.getPost(firstPost.id)
  timings.firstById = Date.now() - t0
  const byIdOk = byId.id === firstPost.id && byId.message === firstPost.message

  // 2. Via channel paging (Mattermost caps per_page at 200; oldest posts are at the highest page).
  const t1 = Date.now()
  const perPage = 200
  const lastPage = Math.floor((TOTAL - 1) / perPage)
  const pagePosts = await mm.getChannelPosts(channel.id, { page: lastPage, perPage })
  timings.firstByPage = Date.now() - t1
  const pageOk = pagePosts.some((p) => p.id === firstPost.id)

  // 3. Via search.
  const t2 = Date.now()
  const searchResults = await mm.searchPosts(team.id, firstPost.message)
  timings.firstBySearch = Date.now() - t2
  const searchOk = searchResults.some((p) => p.id === firstPost.id)

  // Cleanup: archive the scratch channel.
  try {
    await mm.deleteChannel(channel.id)
    console.log('Scratch channel archived.')
  } catch (e) {
    console.error('Failed to archive scratch channel:', (e as Error).message)
  }

  const postMs = timings.postEnd - timings.postStart
  console.log('\n--- History limit check ---')
  console.log(`Total posts:            ${TOTAL}`)
  console.log(`Post elapsed:           ${(postMs / 1000).toFixed(1)}s (${(TOTAL / (postMs / 1000)).toFixed(1)} posts/s)`)
  console.log(`Retrieve by id:         ${byIdOk ? 'OK' : 'FAIL'} (${timings.firstById}ms)`)
  console.log(`Retrieve by page:       ${pageOk ? 'OK' : 'FAIL'} (${timings.firstByPage}ms)`)
  console.log(`Retrieve by search:     ${searchOk ? 'OK' : 'FAIL'} (${timings.firstBySearch}ms)`)
  console.log(`VERDICT: ${byIdOk && pageOk && searchOk ? 'No 10k cap observed' : 'CAP OR BUG DETECTED'}`)

  if (!byIdOk || !pageOk || !searchOk) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
