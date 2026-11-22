/** Stateless semantic message classification for Company Agent group chats using DSH's configured LLM route. */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig, type RequestMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { Settings } from '../policy.ts'
import { companyAgentTriagePrompt } from './context.ts'

const TRIAGE_TIMEOUT_MS = 15_000
const MAX_RESPONSE_CHARS = 4096

export const CompanyAgentClassifyAttachmentSchema = z.object({
  filename: z.string().trim().max(255).optional(),
  content_type: z.string().trim().max(120).optional(),
}).strict()

export const CompanyAgentClassifyContextItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  actor: z.string().trim().max(120).optional(),
  text: z.string().max(4000),
  at: z.string().trim().max(80).optional(),
  attachments: z.array(z.string().trim().max(255)).max(10).optional(),
}).strict()

export const CompanyAgentClassifySchema = z.object({
  source_type: z.enum(['qq.group', 'qq.guild', 'wecom.group']),
  conversation_id: z.string().trim().min(1).max(200),
  actor_id: z.string().trim().min(1).max(200),
  actor_label: z.string().trim().max(120).optional(),
  content: z.string().min(1).max(12_000),
  has_attachments: z.boolean().optional(),
  attachments: z.array(CompanyAgentClassifyAttachmentSchema).max(10).optional(),
  bot_aliases: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  recent_messages: z.array(CompanyAgentClassifyContextItemSchema).max(20).optional(),
}).strict()

export type CompanyAgentClassifyInput = z.infer<typeof CompanyAgentClassifySchema>

export const CompanyAgentTriageClassSchema = z.enum(['direct', 'ongoing_discussion', 'chatter'])
export type CompanyAgentTriageClass = z.infer<typeof CompanyAgentTriageClassSchema>

export interface CompanyAgentClassifyResult {
  classification: CompanyAgentTriageClass
  reason: string
  model?: string
}

/** HTTP-mapped failure raised when stateless triage cannot reach an LLM or receives malformed output. */
export class TriageError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export interface TriageHost {
  readonly ctx: Context
  readonly settings: () => Settings
  readonly masterId: () => string
}

/** Extracts and validates `{ classification, reason }` JSON from a classifier completion. */
export function parseTriageResponse(raw: string): CompanyAgentClassifyResult {
  const trimmed = raw.trim()
  const unwrapped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const candidates = [unwrapped]
  const start = unwrapped.indexOf('{'), end = unwrapped.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(unwrapped.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const classification = CompanyAgentTriageClassSchema.parse(parsed.classification)
      const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 300)
        : classification
      return { classification, reason }
    } catch {
      // Try next slice.
    }
  }
  const token = unwrapped.match(/\b(direct|ongoing_discussion|chatter)\b/)
  if (token) {
    const classification = CompanyAgentTriageClassSchema.parse(token[1])
    return { classification, reason: classification }
  }
  throw new TriageError(502, 'Classifier returned unparseable classification output')
}

/**
 * Classifies an un-`@`-mentioned group message semantically without mutating orchestrator Session history.
 * Reads recent conversation turns, attachment presence, and optional alias hints via a single stateless `ctx.llm` call.
 */
export class CompanyAgentClassifier {
  constructor(private readonly host: TriageHost) {}

  async classify(rawInput: unknown, signal?: AbortSignal): Promise<CompanyAgentClassifyResult> {
    const input = CompanyAgentClassifySchema.parse(rawInput)
    const timeout = AbortSignal.timeout(TRIAGE_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    const llm = this.host.ctx.llm as Partial<Context['llm']> | undefined
    if (!llm?.prepareCall) throw new TriageError(503, 'Stateless LLM prepareCall is unavailable for triage')

    const baseConfig = await this.resolveConfig(llm, combined)
    const desiredConfig: LlmCallConfig = {
      ...baseConfig,
      maxTokens: baseConfig.maxTokens ?? 256,
      ...(baseConfig.reasoningEffort || baseConfig.temperature !== undefined ? {} : { temperature: 0 }),
    }
    const callConfig = llm.resolveCallConfig ? await llm.resolveCallConfig(desiredConfig, combined) : desiredConfig
    const prepared = await llm.prepareCall(callConfig, combined)
    const envelope = {
      protocol: 'company-agent-triage-v1',
      source_type: input.source_type,
      conversation_id: input.conversation_id,
      bot_aliases: input.bot_aliases ?? [],
      recent_messages: input.recent_messages ?? [],
      current_message: {
        actor: input.actor_label || input.actor_id,
        text: input.content,
        has_attachments: input.has_attachments ?? Boolean(input.attachments?.length),
        attachments: input.attachments ?? [],
      },
    }
    const messages: RequestMessage[] = [{
      role: 'user',
      content: [{
        type: 'text',
        text: `<untrusted_group_messages>\n${JSON.stringify(envelope)}\n</untrusted_group_messages>`,
      }],
    }]

    let collected = ''
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages,
      system: companyAgentTriagePrompt,
      signal: combined,
    })) {
      if (chunk.type === 'text-delta') {
        collected += chunk.text
        if (collected.length > MAX_RESPONSE_CHARS) break
      }
    }
    if (!collected.trim()) throw new TriageError(502, 'Classifier model returned empty output')
    const result = parseTriageResponse(collected)
    return { ...result, model: `${prepared.config.provider}/${prepared.config.model}` }
  }

  private async resolveConfig(llm: Partial<Context['llm']>, signal: AbortSignal): Promise<LlmCallConfig> {
    const evalModel = this.host.settings().eval.model
    let candidate: LlmCallConfig | undefined = evalModel
      ? {
          provider: evalModel.provider,
          model: evalModel.model,
          ...(evalModel.reasoningEffort ? { reasoningEffort: ReasoningEffortId(evalModel.reasoningEffort) } : {}),
        }
      : undefined

    if (!candidate) {
      const controller = this.host.ctx.sessionController as Partial<Context['sessionController']> | undefined
      const resolved = await controller?.resolveAgent?.(this.host.masterId() as SessionId).catch(() => undefined)
      const agent = resolved && 'agent' in resolved ? resolved.agent as {
        options?: { provider?: string; model?: string; reasoningEffort?: string }
        session?: { requestHeader?: () => { config?: LlmCallConfig } | undefined }
      } : undefined
      const headerConfig = agent?.session?.requestHeader?.()?.config
      if (headerConfig?.provider && headerConfig?.model) {
        candidate = { provider: headerConfig.provider, model: headerConfig.model }
      } else if (agent?.options?.provider && agent?.options?.model) {
        candidate = { provider: agent.options.provider, model: agent.options.model }
      }
      if (!candidate) {
        const catalog = await controller?.modelCatalog?.().catch(() => undefined)
        const def = catalog?.default
        if (def?.provider && def?.model) {
          candidate = { provider: def.provider, model: def.model }
        } else {
          const group = catalog?.groups.find(item => item.models.length > 0)
          const model = group?.models[0]
          if (group && model) candidate = { provider: group.id, model: model.id }
        }
      }
    }

    if (!candidate) throw new TriageError(503, 'No LLM model route available for triage')
    return llm.resolveCallConfig ? await llm.resolveCallConfig(candidate, signal) : candidate
  }
}
