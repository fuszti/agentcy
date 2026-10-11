// Shared contracts for the agent office. Every module codes against these types.
// Keep this file dependency-free.

export type Harness = 'claude' | 'opencode'

/** office.config.json at the repo root (committed, no secrets). */
export interface OfficeConfig {
  /** Base URL of Mattermost as seen from agents, e.g. http://127.0.0.1:8065 */
  mattermostUrl: string
  /** Base URL of Forgejo as seen from agents, e.g. http://127.0.0.1:3033 */
  forgejoUrl: string
  /**
   * URLs the owner opens (LAN / Tailscale address on a home server). Shown in status footers.
   * Agents keep using mattermostUrl/forgejoUrl. Written by `office setup`; defaults to those.
   */
  publicUrls?: { mattermost: string; forgejo: string }
  /** Mattermost team name (slug) all agents join. */
  team: string
  /** Forgejo organisation that owns office repos. */
  forgejoOrg: string
  /** Forgejo repo (inside forgejoOrg) used for general tickets. */
  ticketsRepo: string
  /** The one human. Username is used on both Mattermost and Forgejo. */
  human: { username: string; displayName: string }
  /** Channels every agent joins on hire. Names without the ag- prefix are mixed (human + agents). */
  defaultChannels: string[]
  /** Prefix that marks an agent-only channel (human reads, does not post). */
  agentChannelPrefix: string // "ag-"
  /** tmux session that hosts one window per agent. */
  tmuxSession: string // "office"
  /** Private owner-only channel for office chat-ops commands. */
  adminChannel: string // "office-admin"
  /** Private owner-only channel for the finance report/console (same membership as adminChannel). */
  financeChannel: string // "office-finance"
  /** First TCP port handed to opencode agents' built-in servers. */
  opencodeBasePort: number // 4100
  /** Usernames that are system bots (e.g. "office"). Used for room-request detection only. */
  systemUsernames?: string[]
  defaults: {
    claudeModel: string // e.g. "sonnet"
    opencodeModel: string // e.g. "opencode-go/kimi-k2.7-code"
    /** Cheap opencode model used for summarising transcripts during merge. */
    summarizerModel: string // e.g. "opencode-go/deepseek-v4.1-flash"
    /** Cheap/fast model for the #office-admin generate helper. */
    helperModel: string // e.g. "opencode-go/deepseek-v4.1-flash"
    digestMinutes: number // 10
  }
  limits: GuardLimits
  selfManagement: SelfManagementConfig
  watchdog: WatchdogConfig
  git: GitConfig
  /** Resource groups (subscriptions / AI API providers) tracked by the finance feature. */
  resourceGroups: ResourceGroup[]
  finance: FinanceConfig
  /** Mattermost file attachments (chat_upload / inbound download). Optional: defaults apply when absent. */
  attachments?: AttachmentsConfig
}

export interface AttachmentsConfig {
  /** Max bytes for an inbound download or outbound chat_upload. Default 20 MiB. */
  maxBytes: number
}

/** One billable resource: a subscription or API provider agents' usage is billed against. */
export type ResourceGroupKind = 'claude-subscription' | 'opencode-go' | 'openrouter'

export interface ResourceGroup {
  id: string
  kind: ResourceGroupKind
  label: string
  /**
   * claude-subscription only: CLAUDE_CONFIG_DIR of this subscription's login, relative to the
   * office root (e.g. "state/claude/claude-b"). Unset = the user's own ~/.claude (or
   * $CLAUDE_CONFIG_DIR), which is how the first/default Claude group works.
   */
  configDir?: string
}

export interface FinanceConfig {
  /** Local hour (0-23) the daily finance report is posted in #office-finance. */
  dailyReportHour: number // 9
  /** Usage-percent thresholds (of a group's known limit) that trigger one alert each, ascending. */
  usageAlertThresholds: number[] // [75, 90, 100]
  /** An agent spending more than this multiple of its trailing 7-day hourly average in the last hour triggers a spike alert. */
  spikeMultiplier: number // 5
  /** Rolling-window usage-% thresholds for the Limits section (Claude session/week, OpenCode Go rolling/weekly/monthly). */
  limitAlertThresholds: number[] // [80, 95]
  /**
   * OpenCode Go per-model MONTHLY dollar cap (https://opencode.ai/docs/go/), applied at 20%
   * (5h) / 50% (week) / 100% (month) of this figure. Used only as a local fallback estimate
   * when the exact opencode.ai/zen/go/v1/usage endpoint is unreachable.
   */
  opencodeGoMonthlyDollarCap: Record<string, number>
  /** Request-count caps per model/window (5h/week/month), an even coarser internal fallback. Not rendered. */
  opencodeGoLimits: Record<string, OpencodeGoModelLimits>
}

/** Request-count caps for one OpenCode Go model, from https://opencode.ai/docs/go/. */
export interface OpencodeGoModelLimits {
  '5h': number
  week: number
  month: number
}

export interface GuardLimits {
  postsPerMinute: number // 8
  postsPerHour: number // 100
  /** Reject a post whose text equals one of the agent's last N posts. */
  duplicateWindow: number // 5
  /** Max consecutive agent-authored posts in one thread (no human in between) for mixed channels. */
  agentThreadCapMixed: number // 12
  /** Same, for agent-only (ag-*) channels. */
  agentThreadCapAgentOnly: number // 25
}

export interface SelfManagementConfig {
  maxAgents: number
  maxForksPerAgent: number
  autoApproveFork: { opencode: boolean; claude: boolean }
  autoMergeOnDone: boolean
  allowSelfShift: boolean
  /** Agents may create projects themselves when true. */
  autoApproveProject: boolean
  /** Maximum active (non-archived) projects allowed in the office. */
  maxActiveProjects: number
  /** Maximum project creation requests one agent may create per calendar day. */
  maxNewProjectsPerAgentPerDay: number
}

export interface WatchdogConfig {
  /** Minutes of inactivity before a claimed/promised ticket is flagged as stale. */
  staleWorkMinutes: number
  /** Seconds between watchdog alert scans in the admin daemon. */
  alertIntervalSeconds: number
}

export interface GitConfig {
  /** If true, agents may push to GitHub. Disabled by default so agents only push to the office Forgejo. */
  allowGithubPush: boolean
}

/** Secrets and runtime ids: state/office.json (gitignored). */
export interface OfficeSecrets {
  mattermost: { adminToken: string; teamId: string; humanUserId: string; humanPassword: string }
  forgejo: { adminToken: string; humanPassword: string }
  /** The office-wide admin bot that listens in #office-admin. */
  officeBot?: { userId: string; token: string }
}

/** One hired agent: state/agents/<name>/agent.json (gitignored). */
export interface AgentRecord {
  name: string // lowercase slug, also the Mattermost + Forgejo username
  displayName: string
  harness: Harness
  model: string
  status: 'hired' | 'retired'
  /** Harness session id of the current "desk" session (Claude UUID or opencode ses_...). */
  sessionId?: string
  /** Previous desk sessions, newest last (shift changes, restarts). */
  pastSessions: string[]
  chrome: boolean
  mattermost: { userId: string; token: string }
  forgejo: { token: string }
  /** opencode only: port of the agent's built-in HTTP server. */
  opencodePort?: number
  /**
   * Resource group (config.resourceGroups id) this agent runs on and bills against. Unset or
   * not matching the harness/model = the first group of the matching kind (the default).
   */
  group?: string
  /** Set when this agent was created by `office fork`. */
  forkedFrom?: ForkInfo
  createdAt: string
}

export interface ForkInfo {
  parent: string
  parentSessionId: string
  /** Number of transcript entries (messages) the fork inherited; merge only replays what came after. */
  inheritedMessages: number
  forkedAt: string
}

/** Runtime status written by harness hooks / watchers: state/agents/<name>/status.json */
export interface AgentStatus {
  state: 'starting' | 'idle' | 'busy' | 'blocked' | 'stopped'
  /** ISO timestamp of the last transition. */
  at: string
  detail?: string
}

// ---------------------------------------------------------------- humans

/** The owner approves and administers; a member is an invited collaborator. */
export type HumanRole = 'owner' | 'member'

/** One person as the delivery policy sees them. Matched by Mattermost user id. */
export interface Human {
  userId: string
  username: string
  role: HumanRole
  /** Projects a member was invited to. Unset for the owner. */
  projects?: string[]
}

/** One invited member: an entry of state/members.json (no secrets). */
export interface MemberRecord {
  /** Same name on Mattermost and Forgejo. Never reused, also after removal. */
  username: string
  displayName: string
  role: 'member'
  mattermostUserId: string
  forgejoUsername: string
  projects: string[]
  /** Extra channels besides the project channels. */
  channels: string[]
  invitedAt: string
  /** ISO time of `office uninvite`, else null. */
  removedAt: string | null
}

// ---------------------------------------------------------------- inbound events

export type EventKind =
  | 'dm' // direct message to the agent
  | 'mention' // @agent in any channel
  | 'thread' // new reply in a thread the agent started or posted in
  | 'room' // the owner asked the room (top-level post, nobody @mentioned): first taker claims it
  | 'channel' // other message in a channel the agent watches with mode "all"
  | 'digest-item' // message collected for the periodic digest
  | 'ticket' // Forgejo notification (assigned, mentioned, commented, review requested...)
  | 'system' // office notices (shift change, merge, freeze...)

export interface InboundEvent {
  kind: EventKind
  /** Stable id for dedup, e.g. "mm:<post_id>" or "fj:<notification_id>". */
  id: string
  at: string // ISO
  from: string // username
  fromHuman: boolean
  text: string
  /** Mattermost context. */
  channel?: string // channel name (slug); for DMs "dm"
  channelType?: 'mixed' | 'agent-only' | 'dm'
  postId?: string
  /** Root post id if the message is in a thread (or the post itself when it starts one). */
  threadId?: string
  /** Extra guidance rendered as a note attribute (e.g. claim instructions). */
  note?: string
  /** Forgejo context. */
  ticket?: { repo: string; number: number; title: string; url: string; reason: string }
  /** Files attached to the source post. Immediate events get a local `path` (downloaded); digest items only get name/size. */
  attachments?: EventAttachment[]
}

export interface EventAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  /** Absolute local path once downloaded. */
  path?: string
  /** Reason the file was not downloaded, e.g. "too large (37.0 MB)". */
  skipped?: string
}

/** How an agent follows a channel it is a member of. */
export type WatchMode = 'all' | 'digest' | 'mentions'

// ---------------------------------------------------------------- wake adapters

/**
 * Delivers rendered event batches into the agent's live harness session.
 * Implementations: tmux paste for Claude Code TUI, HTTP prompt for opencode.
 */
export interface WakeAdapter {
  /** True when the session can take a new prompt right now. */
  isIdle(): Promise<boolean>
  /** Deliver one prompt. Resolves once handed to the harness (not when processed). */
  deliver(text: string): Promise<void>
  /** Is the harness process alive at all? */
  isAlive(): Promise<boolean>
}

// ---------------------------------------------------------------- platform clients

export interface ChatPost {
  id: string
  channelId: string
  channel: string
  userId: string
  username: string
  message: string
  rootId?: string
  createAt: number
  /** Mattermost post type: absent for normal posts, "system_*" for system messages (joins, adds, header changes). */
  type?: string
  /** Files attached to the post, if any. */
  files?: ChatFile[]
}

export interface ChatFile {
  id: string
  name: string
  mimeType: string
  size: number
}

export interface ChatChannel {
  id: string
  name: string
  displayName: string
  purpose: string
  type: 'O' | 'P' | 'D' | 'G'
}

// ---------------------------------------------------------------- transcripts (fork / merge)

/** Harness-neutral view of one transcript message, used to replay context during merge. */
export interface TranscriptEntry {
  role: 'user' | 'assistant'
  /** Plain text parts joined with blank lines (may be empty for tool-only turns). */
  text: string
  tools: { name: string; input: string; result?: string; isError?: boolean }[]
  at?: string
}

// ---------------------------------------------------------------- self-management requests

export type RequestType = 'fork' | 'merge' | 'shift' | 'hire' | 'project'
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'done' | 'failed'

/** A signed agent request stored in state/requests/{id}.json. */
export interface OfficeRequest {
  id: string
  type: RequestType
  /** Agent that created the request. */
  agent: string
  args: Record<string, unknown>
  status: RequestStatus
  createdAt: string
  /** Mattermost post id of the approval prompt in #office-admin. */
  approvalPostId?: string
  /** Result/error after execution. */
  result?: string
}

// ---------------------------------------------------------------- projects

/** A project: its own Forgejo repo, Mattermost channel, and member list. */
export interface ProjectRecord {
  name: string
  description: string
  /** Repo slug inside the office org, e.g. "office/hello-agents". */
  repo: string
  channel: string
  members: string[]
  createdAt: string
  archived?: boolean
  /** Agent that created the project via office_create_project. */
  createdBy?: string
}
