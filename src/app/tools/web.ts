/** Controlled web tools: Company Agent owns web search and checks its switch for every call. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../../core/errors.ts'
import { tool, type Tool } from './tool.ts'
import { z } from 'zod'

interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly { url: string; title?: string; snippet?: string; publishedAt?: string; engine?: string }[]
  readonly truncated: boolean
}
interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: { kind: 'html' | 'text'; content: string }
  readonly truncated: boolean
}
interface WebRuntime {
  fetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResult>
}

const MAX_RESULTS = 8
const REQUEST_ID = () => `dssuperagent-web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

function webRuntime(context: Context): WebRuntime {
  const web = (context as unknown as { web?: WebRuntime }).web
  if (!web || typeof web.fetch !== 'function') throw new UserError('webSearchUnavailable')
  return web
}

function gateEndpoint(route: 'authorize' | 'search' = 'authorize'): URL {
  const endpoint = new URL(process.env.COMPANY_AGENT_WEB_GATE_URL ?? 'http://127.0.0.1:28767/internal/web/authorize')
  if (route === 'search') endpoint.pathname = '/internal/web/search'
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new UserError('webSearchUnavailable')
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]'
  const bridgeKey = process.env.COMPANY_AGENT_WEB_GATE_API_KEY ?? process.env.COMPANY_AGENT_KNOWLEDGE_API_KEY ?? ''
  if (!loopback && bridgeKey.length < 32) throw new UserError('webSearchUnavailable')
  return endpoint
}

async function postGate(endpoint: URL, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const bridgeKey = process.env.COMPANY_AGENT_WEB_GATE_API_KEY ?? process.env.COMPANY_AGENT_KNOWLEDGE_API_KEY ?? ''
  try {
    return await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bridgeKey ? { 'X-Company-Agent-Bridge-Key': bridgeKey } : {}) },
      body: JSON.stringify({ ...body, request_id: REQUEST_ID() }),
      signal,
    })
  } catch {
    throw new UserError('webSearchUnavailable')
  }
}

async function authorizeFetch(target: string, signal: AbortSignal): Promise<void> {
  const response = await postGate(gateEndpoint(), { operation: 'fetch', url: target }, signal)
  if (response.status === 403) throw new UserError('webSearchDisabled')
  if (!response.ok) throw new UserError('webFetchFailed', { status: String(response.status) })
}

function webError(code: 'webFetchFailed', error?: unknown): never {
  const providerCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (providerCode === 'WEB_PROVIDER_CREDENTIAL_MISSING') throw new UserError('webSearchCredentialMissing')
  throw new UserError(code, { status: 'provider' })
}

export function webTools(context: Context): Tool[] {
  return [
    tool({
      name: 'orchestrator_web_search',
      description: 'Search via Company Agent and cite the returned sources.',
      schema: z.object({ query: z.string().trim().min(1).max(2000) }).strict(),
      execute: async ({ query }, signal) => {
        let response: Response
        try { response = await postGate(gateEndpoint('search'), { query, max_results: MAX_RESULTS }, signal) }
        catch (error) {
          if (error instanceof UserError) throw error
          throw new UserError('webSearchFailed', { status: 'request' })
        }
        if (response.status === 403) throw new UserError('webSearchDisabled')
        if (!response.ok) throw new UserError('webSearchFailed', { status: String(response.status) })
        let result: WebSearchResult
        try { result = await response.json() as WebSearchResult } catch { throw new UserError('webSearchFailed', { status: 'invalid-response' }) }
        if (!result || !Array.isArray(result.sources) || typeof result.truncated !== 'boolean') {
          throw new UserError('webSearchFailed', { status: 'invalid-response' })
        }
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
            ...(source.engine ? { engine: source.engine } : {}),
          })),
        }
      },
    }),
    tool({
      name: 'orchestrator_web_fetch',
      description: 'Read a URL after Company Agent authorizes it; prefer search results.',
      schema: z.object({ url: z.string().trim().url().max(2000) }).strict(),
      execute: async ({ url }, signal) => {
        await authorizeFetch(url, signal)
        let result: WebFetchResult
        try { result = await webRuntime(context).fetch({ url }, signal) } catch (error) { webError('webFetchFailed', error) }
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
