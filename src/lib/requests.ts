// Signed agent self-management requests stored in state/requests/.
// Requests are JSON files signed with the shared inbox HMAC so the admin daemon
// can verify provenance before executing them.

import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OfficeRequest, RequestStatus, RequestType } from './types.js'
import { ensureInboxKey } from './inbox.js'

const REQUESTS_DIR = 'requests'
const SIG_PREFIX = '<!-- office-req-sig:'
const SIG_SUFFIX = ' -->'

/** Directory that holds request files: state/requests. */
export function requestsDir(root: string): string {
  return path.join(root, 'state', REQUESTS_DIR)
}

function requestPath(root: string, id: string): string {
  return path.join(requestsDir(root), `${id}.json`)
}

/** Stable canonical JSON for a request (sorted keys at all depths, no signature fields). */
export function canonicalizeRequest(req: Omit<OfficeRequest, 'id'> | OfficeRequest): string {
  return JSON.stringify(req, sortReplacer)
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  }
  return value
}

function sign(text: string, key: Buffer): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex')
}

/** Sign a request, returning the signed file content. */
export function signRequest(req: OfficeRequest, key: Buffer): string {
  const canonical = canonicalizeRequest(req)
  const sig = sign(canonical, key)
  return `${SIG_PREFIX}${sig}${SIG_SUFFIX}\n${JSON.stringify(req, null, 2)}\n`
}

/** Verify a signed request file. Returns the request or undefined if invalid. */
export function verifyRequest(fileText: string, key: Buffer): OfficeRequest | undefined {
  if (!fileText.startsWith(SIG_PREFIX)) return undefined
  const end = fileText.indexOf(SIG_SUFFIX)
  if (end < 0) return undefined
  const sig = fileText.slice(SIG_PREFIX.length, end)
  const rest = fileText.slice(end + SIG_SUFFIX.length)
  const json = rest.trimStart()
  let req: OfficeRequest
  try {
    req = JSON.parse(json) as OfficeRequest
  } catch {
    return undefined
  }
  const expected = sign(canonicalizeRequest(req), key)
  if (!timingSafeEqual(sig, expected)) return undefined
  return req
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Atomically write a signed request file to state/requests. */
export async function writeRequest(root: string, req: OfficeRequest): Promise<void> {
  const dir = requestsDir(root)
  await mkdir(dir, { recursive: true })
  const key = await ensureInboxKey(root)
  const file = requestPath(root, req.id)
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, signRequest(req, key))
  await rename(tmp, file)
}

/** Load and verify a request file. Returns undefined if missing or invalid. */
export async function loadRequest(root: string, id: string): Promise<OfficeRequest | undefined> {
  const file = requestPath(root, id)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const key = await ensureInboxKey(root)
  return verifyRequest(raw, key)
}

/** Load every request file (skipping invalid ones). */
export async function listRequests(root: string): Promise<OfficeRequest[]> {
  const dir = requestsDir(root)
  if (!fs.existsSync(dir)) return []
  const files = await readdir(dir)
  const key = await ensureInboxKey(root)
  const out: OfficeRequest[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const raw = await readFile(path.join(dir, f), 'utf8').catch(() => '')
    const req = verifyRequest(raw, key)
    if (req) out.push(req)
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Update a request file in place (re-signs it). */
export async function updateRequest(root: string, id: string, patch: Partial<OfficeRequest>): Promise<OfficeRequest | undefined> {
  const req = await loadRequest(root, id)
  if (!req) return undefined
  const updated: OfficeRequest = { ...req, ...patch }
  await writeRequest(root, updated)
  return updated
}

/** Factory for a new request id. */
export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '')}`
}

/** Build a new request object (not yet written). */
export function buildRequest(type: RequestType, agent: string, args: Record<string, unknown>): OfficeRequest {
  return {
    id: newRequestId(),
    type,
    agent,
    args,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
}

/** Convenience: set status + optional result in one call. */
export async function setRequestStatus(
  root: string,
  id: string,
  status: RequestStatus,
  result?: string,
): Promise<OfficeRequest | undefined> {
  return updateRequest(root, id, result !== undefined ? { status, result } : { status })
}
