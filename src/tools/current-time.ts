import { z } from 'zod'
import type { Tool } from 'marco-harness'

const inputSchema = z.object({
  timezone: z.string().optional(),
})

export const currentTimeTool: Tool = {
  name: 'current_time',
  description: 'Returns the current date and time. Optionally accepts an IANA timezone (e.g. "America/Chicago", "UTC"). Defaults to UTC.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone identifier. Defaults to UTC.',
      },
    },
  },
  validate: (input) => inputSchema.parse(input),
  handler: async (input) => {
    const { timezone = 'UTC' } = input as z.infer<typeof inputSchema>
    return new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' })
  },
}
