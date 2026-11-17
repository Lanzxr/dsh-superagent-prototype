import { describe, expect, it } from 'vitest'
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
})
