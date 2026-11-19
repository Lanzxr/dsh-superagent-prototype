import { afterEach, describe, expect, it, vi } from 'vitest'
import { webTools } from '../src/app/tools/web.ts'

const context = { web: {
  fetch: vi.fn(async ({ url }: { url: string }) => ({ url, statusCode: 200, body: { kind: 'text' as const, content: 'page' }, truncated: false })),
} }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('controlled web tools', () => {
  it('refuses search when the Company Agent switch is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'web search is disabled' }), { status: 403 })))
    const search = webTools(context as never).find(tool => tool.name === 'orchestrator_web_search')!
    await expect(search.execute({ query: 'current status' }, new AbortController().signal)).rejects.toMatchObject({ code: 'webSearchDisabled' })
  })

  it('uses the Company Agent search route and returns citeable backend sources', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ query: 'current status', content: 'answer', truncated: false,
      sources: [{ url: 'https://example.com/source', title: 'Source', snippet: 'Evidence', publishedAt: '2026-11-18', engine: 'test' }] }), { status: 200 })))
    const search = webTools(context as never).find(tool => tool.name === 'orchestrator_web_search')!
    const result = await search.execute({ query: 'current status' }, new AbortController().signal) as Record<string, unknown>
    expect(vi.mocked(fetch).mock.calls.length).toBe(1)
    const request = vi.mocked(fetch).mock.calls[0]!
    expect(String(request[0])).toContain('/internal/web/search')
    expect(JSON.parse(String((request[1] as RequestInit).body))).toMatchObject({ query: 'current status', max_results: 8 })
    expect(result).toMatchObject({ query: 'current status', content: 'answer', truncated: false,
      sources: [{ url: 'https://example.com/source', title: 'Source', snippet: 'Evidence', published_at: '2026-11-18', engine: 'test' }] })
    expect(typeof result.retrieved_at).toBe('string')
  })

  it('does not call the search backend when Company Agent rejects the search', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'disabled' }), { status: 403 }))
    vi.stubGlobal('fetch', request)
    const search = webTools(context as never).find(tool => tool.name === 'orchestrator_web_search')!
    await expect(search.execute({ query: 'current status' }, new AbortController().signal)).rejects.toMatchObject({ code: 'webSearchDisabled' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports missing fetch provider credentials without assuming a provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authorized: true }), { status: 200 })))
    const providerError = Object.assign(new Error('private provider diagnostic'), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    context.web.fetch.mockRejectedValueOnce(providerError)
    const selected = webTools(context as never).find(tool => tool.name === 'orchestrator_web_fetch')!
    await expect(selected.execute({ url: 'https://example.com/page' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'webSearchCredentialMissing',
      message: 'The configured web provider is missing its required credential',
    })
  })

  it('uses the same gate for page fetches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authorized: true }), { status: 200 })))
    const fetchTool = webTools(context as never).find(tool => tool.name === 'orchestrator_web_fetch')!
    const result = await fetchTool.execute({ url: 'https://example.com/page' }, new AbortController().signal) as Record<string, unknown>
    expect(context.web.fetch).toHaveBeenCalledWith({ url: 'https://example.com/page' }, expect.any(AbortSignal))
    expect(result).toMatchObject({ requested_url: 'https://example.com/page', final_url: 'https://example.com/page', status_code: 200, content: 'page' })
  })
})
