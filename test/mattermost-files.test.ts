import { describe, expect, it, vi, afterEach } from 'vitest'
import { MattermostClient } from '../src/lib/mattermost.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('MattermostClient file attachments', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('getFileInfo maps snake_case FileInfo to ChatFile', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      expect(url).toContain('/files/f1/info')
      return Promise.resolve(jsonResponse({ id: 'f1', name: 'shot.png', mime_type: 'image/png', size: 12345 }))
    }))
    const mm = new MattermostClient('http://mm', 'tok')
    expect(await mm.getFileInfo('f1')).toEqual({ id: 'f1', name: 'shot.png', mimeType: 'image/png', size: 12345 })
  })

  it('downloadFile returns the raw body as a Buffer', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      expect(url).toContain('/files/f1')
      return Promise.resolve(new Response(bytes, { status: 200 }))
    }))
    const mm = new MattermostClient('http://mm', 'tok')
    const buf = await mm.downloadFile('f1')
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect([...buf]).toEqual([1, 2, 3, 4])
  })

  it('downloadFile throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }))))
    const mm = new MattermostClient('http://mm', 'tok')
    await expect(mm.downloadFile('missing')).rejects.toThrow(/404/)
  })

  it('uploadFile posts multipart form data and returns the new file id', async () => {
    let capturedBody: FormData | undefined
    let capturedUrl = ''
    let capturedMethod = ''
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedMethod = init?.method ?? ''
      capturedBody = init?.body as FormData
      return Promise.resolve(jsonResponse({ file_infos: [{ id: 'new-file-id', name: 'a.txt' }] }))
    }))
    const mm = new MattermostClient('http://mm', 'tok')
    const id = await mm.uploadFile('chan1', 'a.txt', Buffer.from('hello world'))
    expect(id).toBe('new-file-id')
    expect(capturedUrl).toContain('/api/v4/files')
    expect(capturedMethod).toBe('POST')
    expect(capturedBody).toBeInstanceOf(FormData)
    expect(capturedBody?.get('channel_id')).toBe('chan1')
    const file = capturedBody?.get('files') as File
    expect(file.name).toBe('a.txt')
  })

  it('uploadFile throws with the server message on failure (e.g. over the size limit)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'Unable to upload file. File is too large.' }, 413))
    ))
    const mm = new MattermostClient('http://mm', 'tok')
    await expect(mm.uploadFile('chan1', 'big.bin', Buffer.alloc(10))).rejects.toThrow(/too large/)
  })

  it('createPost sends file_ids and mapPost prefers metadata.files over an extra request', async () => {
    let capturedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/posts') && init?.method === 'POST') {
        capturedBody = JSON.parse(init.body as string)
        return Promise.resolve(jsonResponse({
          id: 'p1', channel_id: 'c1', user_id: 'u1', message: 'here', root_id: '', create_at: 1,
          file_ids: ['f1'],
          metadata: { files: [{ id: 'f1', name: 'shot.png', mime_type: 'image/png', size: 99 }] },
        }))
      }
      if (url.includes('/users/u1')) return Promise.resolve(jsonResponse({ id: 'u1', username: 'zz' }))
      if (url.includes('/channels/c1')) return Promise.resolve(jsonResponse({ id: 'c1', name: 'general', display_name: 'General', purpose: '', type: 'O' }))
      throw new Error(`unexpected fetch ${url}`)
    }))
    const mm = new MattermostClient('http://mm', 'tok')
    const post = await mm.createPost({ channelId: 'c1', message: 'here', fileIds: ['f1'] })
    expect(capturedBody?.file_ids).toEqual(['f1'])
    expect(post.files).toEqual([{ id: 'f1', name: 'shot.png', mimeType: 'image/png', size: 99 }])
  })
})
