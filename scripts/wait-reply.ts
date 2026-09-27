// Wait until <username> replies in the thread of <post_id>. Usage: tsx scripts/wait-reply.ts <post_id> <username> [timeoutSec]
import { loadConfig, loadSecrets } from '../src/lib/config.js'
import { MattermostClient } from '../src/lib/mattermost.js'

const [postId, username, timeout = '180'] = process.argv.slice(2)
const cfg = await loadConfig()
const secrets = await loadSecrets()
if (!secrets) throw new Error('run office init first')
const mm = new MattermostClient(cfg.mattermostUrl, secrets.mattermost.adminToken)
const end = Date.now() + Number(timeout) * 1000
while (Date.now() < end) {
  const posts = await mm.getPostThread(postId)
  const reply = posts.find(p => p.username === username && p.id !== postId)
  if (reply) { console.log(`REPLY from @${username} after ${Math.round((reply.createAt - posts[0].createAt) / 1000)}s: ${reply.message}`); process.exit(0) }
  await new Promise(r => setTimeout(r, 3000))
}
console.log(`TIMEOUT: no reply from @${username}`); process.exit(1)
