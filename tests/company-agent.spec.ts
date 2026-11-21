import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantIntentSchema } from '../src/app/assessment.ts'
import { CompanyAgentClassifier, parseTriageResponse, TriageError } from '../src/app/triage.ts'
import { SettingsSchema } from '../src/policy.ts'
import { CompanyAgentEventSchema, companyAgentKind, companyAgentTrigger } from '../src/sources/company-agent.ts'

describe('Company Agent Source', () => {
  it('maps a normalized event to an idempotent observed trigger with bounded conversation context', () => {
    const event = CompanyAgentEventSchema.parse({
      event_id: 'event-1', source_type: 'chat', source_id: 'room-1', conversation_id: 'conversation-1',
      actor_id: 'user-1', occurred_at: '2026-11-15T00:00:00.000Z', content: 'Should we change the plan?',
      capabilities: ['dsh.task'], attachments: [],
      knowledge_grant: 'x'.repeat(43),
      context: [{ event_id: 'event-0', actor_id: 'user-2', occurred_at: '2026-11-14T23:59:00.000Z', content: 'Earlier context' }],
    })

    const trigger = companyAgentTrigger(event)

    expect(trigger.id).toBe('company-agent:event-1')
    expect(trigger.threads).toEqual([{ source: 'company-agent', id: 'conversation-1' }])
    expect(trigger.human).toBe(false)
    expect(trigger.meta.row).toBe('events')
    expect(trigger.actor).toEqual({ source: 'chat', id: 'user-1' })
    expect(trigger.text).toContain('Earlier context')
    expect(trigger.text).toContain('untrusted conversation data')
    expect(trigger.text).not.toContain('knowledge_grant')
    expect(trigger.text).not.toContain('x'.repeat(43))
    expect(trigger.meta.knowledgeGrant).toBe('x'.repeat(43))
    expect(companyAgentKind.scope?.({ meta: trigger.meta }, {})).toEqual({
      listened: true, observed: true, row: 'events',
    })
  })

  it('rejects oversized conversations before they enter the DSSuperAgent store', () => {
    const result = CompanyAgentEventSchema.safeParse({
      event_id: 'event-1', source_type: 'chat', source_id: 'room-1', conversation_id: 'conversation-1',
      actor_id: 'user-1', occurred_at: '2026-11-15T00:00:00.000Z', content: 'x'.repeat(12001),
    })

    expect(result.success).toBe(false)
  })
  it('marks only recognized QQ user events as human messages', () => {
    const make = (source_type: string) => companyAgentTrigger({
      event_id: `event-${source_type}`, source_type, source_id: 'room-1', conversation_id: 'conversation-1',
      actor_id: 'user-1', occurred_at: '2026-11-18T00:00:00.000Z', content: 'hello',
      attachments: [], capabilities: [], context: [],
    })

    for (const source of ['qq.group', 'qq.guild', 'qq.direct', 'qq.private', 'qq.c2c']) {
      expect(make(source).human, source).toBe(true)
    }
    expect(make('company-agent.execution-result').human).toBe(false)
    expect(make('chat').human).toBe(false)
  })

  it('forwards interaction_mode, available_capabilities, and role metadata cleanly', () => {
    const event = CompanyAgentEventSchema.parse({
      event_id: 'event-ambient-1',
      source_type: 'qq.group',
      source_id: 'grp-1',
      conversation_id: 'grp-1',
      actor_id: 'user-1',
      occurred_at: '2026-11-19T10:00:00Z',
      content: '这月套餐利润率一直算不清',
      interaction_mode: 'ambient_cooldown',
      available_capabilities: { tier: 'internal', internal_knowledge: true, scripts: ['calc.py'] },
      capabilities: ['dsh.task'],
      attachments: [],
      context: [
        { event_id: 'e-bot-1', role: 'assistant', actor_id: 'company-agent', content: '上一条回复' },
      ],
    })
    const trigger = companyAgentTrigger(event)
    expect(trigger.text).toContain('"interaction_mode": "ambient_cooldown"')
    expect(trigger.text).toContain('"calc.py"')
    expect(trigger.text).toContain('"role": "assistant"')

    const silentWork = AssistantIntentSchema.parse({
      action: 'propose_work',
      rationale: 'Group stalled on margin question and internal calc script can compute it',
      title: '核算套餐利润率',
      objective: 'Compute package profit margins',
      completion_conditions: ['Produce report'],
      silent_ack: true,
      plan_steps: [{ title: 'Compute', objective: 'Run calc', capability: 'dsh.task', completion_conditions: ['Done'] }],
      publication: { recommendation: 'group_update', reason: 'Deliver finished report proactively' },
    })
    expect(silentWork.silent_ack).toBe(true)

    const gapObserve = AssistantIntentSchema.parse({
      action: 'observe',
      rationale: 'Missing ERP margin script',
      completion_conditions: [],
      plan_steps: [],
      capability_gap: {
        topic: '套餐利润率计算',
        summary: '群友询问最新套餐利润率，缺少核算数据源',
        missing_capability: 'ERP 订单与成本表接入脚本',
        gap_kind: 'tool_script',
        suggested_solution: '接入 ERP 成本表脚本后，AI 可自动汇总各套餐利润率',
      },
      publication: { recommendation: 'suppress', reason: 'Do not disturb chat when lacking capability' },
    })
    expect(gapObserve.capability_gap?.gap_kind).toBe('tool_script')
  })

  it('parses fenced, inline-JSON, and bare classification labels robustly and rejects garbage', () => {
    expect(parseTriageResponse('{"classification":"direct","reason":"Follow-up after bot reply"}')).toEqual({
      classification: 'direct', reason: 'Follow-up after bot reply',
    })
    expect(parseTriageResponse('```json\n{"classification": "chatter", "reason": "Just laughter"}\n```')).toEqual({
      classification: 'chatter', reason: 'Just laughter',
    })
    expect(parseTriageResponse('ongoing_discussion')).toEqual({
      classification: 'ongoing_discussion', reason: 'ongoing_discussion',
    })
    expect(() => parseTriageResponse('I cannot decide')).toThrow(TriageError)
  })

  it('runs stateless CompanyAgentClassifier via ctx.llm.prepareCall without mutating session state', async () => {
    const capturedRequests: { system: string; temperature?: number; maxTokens?: number; messages: { content: { text: string }[] }[] }[] = []
    const streamMock = vi.fn(async function* (opts: { system: string; temperature?: number; maxTokens?: number; messages: { content: { text: string }[] }[] }) {
      capturedRequests.push(opts)
      yield { type: 'text-delta', index: 0, text: '{"classification":"direct",' }
      yield { type: 'text-delta', index: 0, text: '"reason":"Continues bot turn"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const preparedConfigs: unknown[] = []
    const prepareCall = vi.fn(async (config: { provider: string; model: string; temperature?: number; maxTokens?: number }) => {
      preparedConfigs.push(config)
      return {
        config,
        stream: streamMock,
      }
    })
    const ctx = new Context()
    ctx.reflect.provide('llm', { resolveCallConfig: async (c: unknown) => c, prepareCall })
    ctx.reflect.provide('sessionController', {
      resolveAgent: async () => ({ error: { code: 'not-found' } }),
      modelCatalog: async () => ({ default: { provider: 'zeno', model: 'deepseek-chat' }, groups: [], failures: [] }),
    })

    const classifier = new CompanyAgentClassifier({
      ctx,
      settings: () => SettingsSchema.parse({}),
      masterId: () => 'orchestrator-test',
    })
    const result = await classifier.classify({
      source_type: 'qq.group',
      conversation_id: 'grp-1',
      actor_id: 'u1',
      actor_label: 'Alice',
      content: '帮我查11月的',
      bot_aliases: ['憨憨'],
      recent_messages: [{ role: 'assistant', actor: 'company-agent', text: '请问查哪个月的报销单？' }],
    })

    expect(result).toEqual({ classification: 'direct', reason: 'Continues bot turn', model: 'zeno/deepseek-chat' })
    expect(prepareCall).toHaveBeenCalledTimes(1)
    const prepCfg = preparedConfigs[0] as { temperature?: number; maxTokens?: number }
    const callArg = capturedRequests[0]!
    expect(callArg.temperature).toBe(prepCfg.temperature)
    expect(callArg.maxTokens).toBe(prepCfg.maxTokens)
    expect(callArg.system).toContain('triage classifier')
    expect(callArg.messages[0]!.content[0]!.text).toContain('<untrusted_group_messages>')
    expect(callArg.messages[0]!.content[0]!.text).toContain('"role":"assistant"')
  })
})
