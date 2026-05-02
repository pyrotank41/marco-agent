import { describe, it, expect } from 'vitest'
import { toolFromZod, z } from '../src/tool-from-zod.js'

describe('toolFromZod', () => {
  it('builds a Tool with derived JSON Schema and zod validation', async () => {
    const tool = toolFromZod({
      name: 'echo',
      description: 'echo back text',
      schema: z.object({ text: z.string() }),
      handler: async ({ text }) => `you said: ${text}`,
    })

    expect(tool.name).toBe('echo')
    expect(tool.description).toBe('echo back text')
    // JSON Schema should be derived from the zod schema
    expect((tool.inputJsonSchema as { type: string }).type).toBe('object')
    const props = (tool.inputJsonSchema as { properties: { text: { type: string } } }).properties
    expect(props.text.type).toBe('string')
    // Validate enforces zod constraints
    expect(() => tool.validate({ text: 'hi' })).not.toThrow()
    expect(() => tool.validate({ text: 123 })).toThrow()
    // Handler runs
    const out = await tool.handler({ text: 'hello' }, { runId: 'r1' })
    expect(out).toBe('you said: hello')
  })

  it('passes through optional category and permissionLevel', () => {
    const tool = toolFromZod({
      name: 'risky',
      description: 'mutation tool',
      schema: z.object({}),
      handler: async () => 'done',
      category: 'write',
      permissionLevel: 'always-ask',
    })
    expect(tool.category).toBe('write')
    expect(tool.permissionLevel).toBe('always-ask')
  })

  it('handles complex schemas (nested objects, arrays, enums)', () => {
    const tool = toolFromZod({
      name: 'complex',
      description: 'complex',
      schema: z.object({
        action: z.enum(['create', 'update', 'delete']),
        items: z.array(z.object({ id: z.string(), count: z.number() })),
      }),
      handler: async () => 'ok',
    })

    expect(() => tool.validate({ action: 'create', items: [{ id: 'a', count: 1 }] })).not.toThrow()
    expect(() => tool.validate({ action: 'invalid', items: [] })).toThrow()
    // Schema export includes the enum
    const schema = tool.inputJsonSchema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema.properties).toBeDefined()
  })
})
