// Validation helpers for agent-initiated project creation requests.

import type { OfficeConfig, OfficeRequest, ProjectRecord } from './types.js'
import { validateProjectName } from './projects.js'

export interface ProjectRequestArgs {
  name: string
  description: string
  members?: string[]
  reason: string
}

/** Normalise and validate the arguments for a project creation request. */
export function validateProjectRequestArgs(raw: Record<string, unknown>): { ok: true; args: ProjectRequestArgs } | { ok: false; reason: string } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  const membersRaw = Array.isArray(raw.members) ? raw.members : undefined
  const members = (membersRaw ?? []).map(m => String(m).trim().toLowerCase()).filter(Boolean)

  const nameValid = validateProjectName(name)
  if (!nameValid.ok) return { ok: false, reason: nameValid.reason }
  if (!description) return { ok: false, reason: 'description is required' }
  if (!reason) return { ok: false, reason: 'reason is required' }
  if (members.some(m => !/^[a-z0-9_-]+$/.test(m))) return { ok: false, reason: 'members must be lowercase usernames' }

  return { ok: true, args: { name, description, members, reason } }
}

function toDateDay(iso: string): string {
  return iso.slice(0, 10)
}

function todayDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Count non-archived projects. */
export function countActiveProjects(projects: ProjectRecord[]): number {
  return projects.filter(p => !p.archived).length
}

/** Count project requests created today by the given agent. */
export function countProjectsCreatedTodayByAgent(requests: OfficeRequest[], agent: string): number {
  const day = todayDay()
  return requests.filter(r => r.type === 'project' && r.agent === agent && toDateDay(r.createdAt) === day).length
}

/** Result of validating a project creation request against office limits and state. */
export interface ProjectRequestValidation {
  ok: true
  args: ProjectRequestArgs
  status: 'approved' | 'pending'
}

export interface ProjectRequestValidationFailure {
  ok: false
  reason: string
}

/**
 * Validate a project creation request against name rules, existing projects,
 * active project cap and per-agent daily cap.
 */
export async function validateProjectRequest(
  args: Record<string, unknown>,
  config: OfficeConfig,
  existingProjects: () => Promise<ProjectRecord[]> | ProjectRecord[],
  existingRequests: () => Promise<OfficeRequest[]> | OfficeRequest[],
  agent: string,
): Promise<ProjectRequestValidation | ProjectRequestValidationFailure> {
  const parsed = validateProjectRequestArgs(args)
  if (!parsed.ok) return parsed

  const projects = await existingProjects()
  if (projects.some(p => p.name === parsed.args.name)) {
    return { ok: false, reason: `project ${parsed.args.name} already exists` }
  }
  if (countActiveProjects(projects) >= config.selfManagement.maxActiveProjects) {
    return { ok: false, reason: `active project limit reached (${config.selfManagement.maxActiveProjects})` }
  }

  const requests = await existingRequests()
  if (countProjectsCreatedTodayByAgent(requests, agent) >= config.selfManagement.maxNewProjectsPerAgentPerDay) {
    return { ok: false, reason: `you already created ${config.selfManagement.maxNewProjectsPerAgentPerDay} projects today` }
  }

  return { ok: true, args: parsed.args, status: config.selfManagement.autoApproveProject ? 'approved' : 'pending' }
}

/** Build the FYI message posted in #office-admin after a project is created. */
export function formatProjectCreatedFyi(req: OfficeRequest, members: string[]): string {
  const { name, description, reason } = req.args as Record<string, unknown>
  const m = members.length ? members.join(', ') : `@${req.agent}`
  return `📁 @${req.agent} created project \`${String(name)}\`: ${description} — members ${m} — reason ${reason}`
}

/** Build the signed system prompt delivered to the requester. */
export function formatProjectCreatedNotice(config: OfficeConfig, name: string, channel: string): string {
  const repoUrl = `${config.forgejoUrl.replace(/\/$/, '')}/${config.forgejoOrg}/${name}`
  const cloneUrl = `${repoUrl}.git`
  return `<office-system kind="project-created">Your project \`${name}\` is ready.\n- Repo URL: ${repoUrl}\n- Clone URL: ${cloneUrl}\n- Channel: #${channel}\nClone it with repo_clone({ project: "${name}" }) and start working.</office-system>`
}
