// Send a DM from the owner to an agent. Usage: tsx scripts/dm.ts <agent> <text>
import { loadConfig, loadSecrets } from '../src/lib/config.js'
import { MattermostClient } from '../src/lib/mattermost.js'
const [agent, ...words] = process.argv.slice(2)
const cfg = await loadConfig()
const s = await loadSecrets()
if (!s) throw new Error('run office init first')
const mm = new MattermostClient(cfg.mattermostUrl, s.mattermost.adminToken)
const other = await mm.getUserByUsername(agent)
const ch = await mm.createDirectChannel(s.mattermost.humanUserId, other.id)
const post = await mm.createPost({ channelId: ch.id, message: words.join(' ') })
console.log(`dm ${post.id} ${ch.id}`)
