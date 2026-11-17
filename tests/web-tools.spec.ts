import { afterEach, describe, expect, it, vi } from 'vitest'
import { webTools } from '../src/app/tools/web.ts'

const context = { web: {
  search: vi.fn(async () => ({ content: 'answer', truncated: false,
    sources: [{ url: 'https://example.com/source', title: 'Source', snippet: 'Evidence', publishedAt: '2026-11-18' }] })),
  fetch: vi.fn(async ({ url }: { url: string }) => ({ url, statusCode: 200, body: { kind: 'text' as const, content: 'page' }, truncated: false })),
} }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('controlled web tools', () => {
  it('refuses before calling the DSH web seam when the Company Agent switch is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'web search is disabled' }), { status: 403 })))
    const search = webTools(context as never).find(tool => tool.name === 'orchestrator_web_search')!
    await expect(search.execute({ query: 'current status' }, new AbortController().signal)).rejects.toMatchObject({ code: 'webSearchDisabled' })
    expect(context.web.search).not.toHaveBeenCalled()
  })

  it('authorizes then returns citeable sources and retrieval time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authorized: true }), { status: 200 })))
    const search = webTools(context as never).find(tool => tool.name === 'orchestrator_web_search')!
    const result = await search.execute({ query: 'current status' }, new AbortController().signal) as Record<string, unknown>
    expect(context.web.search).toHaveBeenCalledWith({ query: 'current status', maxResults: 8 }, expect.any(AbortSignal))
    expect(result).toMatchObject({ query: 'current status', content: 'answer', truncated: false,
      sources: [{ url: 'https://example.com/source', title: 'Source', snippet: 'Evidence', published_at: '2026-11-18' }] })
    expect(typeof result.retrieved_at).toBe('string')
  })

  it('uses the same gate for page fetches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authorized: true }), { status: 200 })))
    const fetchTool = webTools(context as never).find(tool => tool.name === 'orchestrator_web_fetch')!
    const result = await fetchTool.execute({ url: 'https://example.com/page' }, new AbortController().signal) as Record<string, unknown>
    expect(context.web.fetch).toHaveBeenCalledWith({ url: 'https://example.com/page' }, expect.any(AbortSignal))
    expect(result).toMatchObject({ requested_url: 'https://example.com/page', final_url: 'https://example.com/page', status_code: 200, content: 'page' })
  })
})
