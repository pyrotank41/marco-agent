import { toolFromZod, z } from '../tool-from-zod.js'

export const currentTimeTool = toolFromZod({
  name: 'current_time',
  description: 'Returns the current date and time. Optionally accepts an IANA timezone (e.g. "America/Chicago", "UTC"). Defaults to UTC.',
  schema: z.object({
    timezone: z.string().optional().describe('IANA timezone identifier. Defaults to UTC.'),
  }),
  handler: async ({ timezone = 'UTC' }) =>
    new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }),
})
