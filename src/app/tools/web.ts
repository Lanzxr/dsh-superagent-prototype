/** Controlled web tools: Company Agent authorizes every call, DSH performs the retrieval through ctx.web. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../../core/errors.ts'
import { tool, type Tool } from './tool.ts'
import { z } from 'zod'

interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly { url: string; title?: string; snippet?: string; publishedAt?: string }[]
  readonly truncated: boolean
}
interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: { kind: 'html' | 'text'; content: string }
  readonly truncated: boolean
}
interface WebRuntime {
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<WebSearchResult>
  fetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResult>
}

const MAX_RESULTS = 8
const REQUEST_ID = () => `dssuperagent-web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

function webRuntime(context: Context): WebRuntime {
  const web = (context as unknown as { web?: WebRuntime }).web
  if (!web || typeof web.search !== 'function' || typeof web.fetch !== 'function') {
    throw new UserError('webSearchUnavailable')
  }
  return web
}

function gateEndpoint(): URL {
  const endpoint = new URL(process.env.COMPANY_AGENT_WEB_GATE_URL ?? 'http://127.0.0.1:8767/internal/web/authorize')
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new UserError('webSearchUnavailable')
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]'
  const bridgeKey = process.env.COMPANY_AGENT_WEB_GATE_API_KEY ?? process.env.COMPANY_AGENT_KNOWLEDGE_API_KEY ?? ''
  if (!loopback && bridgeKey.length < 32) throw new UserError('webSearchUnavailable')
  return endpoint
}

async function authorize(operation: 'search' | 'fetch', target: string, signal: AbortSignal): Promise<void> {
  const endpoint = gateEndpoint()
  const bridgeKey = process.env.COMPANY_AGENT_WEB_GATE_API_KEY ?? process.env.COMPANY_AGENT_KNOWLEDGE_API_KEY ?? ''
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bridgeKey ? { 'X-Company-Agent-Bridge-Key': bridgeKey } : {}) },
      body: JSON.stringify({ operation, ...(operation === 'search' ? { query: target } : { url: target }), request_id: REQUEST_ID() }),
      signal,
    })
  } catch {
    throw new UserError('webSearchUnavailable')
  }
  if (response.status === 403) throw new UserError('webSearchDisabled')
  if (!response.ok) throw new UserError('webSearchFailed', { status: String(response.status) })
}

function webError(code: 'webSearchFailed' | 'webFetchFailed'): never {
  throw new UserError(code, { status: 'provider' })
}

export function webTools(context: Context): Tool[] {
  return [
    tool({
      name: 'orchestrator_web_search',
      description: 'Search the external web after Company Agent authorization; return citeable sources.',
      schema: z.object({ query: z.string().trim().min(1).max(2000) }).strict(),
      execute: async ({ query }, signal) => {
        await authorize('search', query, signal)
        let result: WebSearchResult
        try { result = await webRuntime(context).search({ query, maxResults: MAX_RESULTS }, signal) } catch { webError('webSearchFailed') }
        return {
          query,
          retrieved_at: new Date().toISOString(),
          ...(result.content ? { content: result.content } : {}),
          truncated: result.truncated,
          sources: result.sources.map(source => ({
            url: source.url,
            ...(source.title ? { title: source.title } : {}),
            ...(source.snippet ? { snippet: source.snippet } : {}),
            ...(source.publishedAt ? { published_at: source.publishedAt } : {}),
          })),
        }
      },
    }),
    tool({
      name: 'orchestrator_web_fetch',
      description: 'Read one web page after Company Agent authorization; prefer URLs returned by search.',
      schema: z.object({ url: z.string().trim().url().max(2000) }).strict(),
      execute: async ({ url }, signal) => {
        await authorize('fetch', url, signal)
        let result: WebFetchResult
        try { result = await webRuntime(context).fetch({ url }, signal) } catch { webError('webFetchFailed') }
        return {
          requested_url: url,
          final_url: result.url,
          status_code: result.statusCode,
          content_type: result.body.kind,
          content: result.body.content,
          truncated: result.truncated,
          retrieved_at: new Date().toISOString(),
        }
      },
    }),
  ]
}
