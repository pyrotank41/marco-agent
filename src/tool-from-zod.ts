// toolFromZod — define a Tool from a single zod schema.
//
// Without this helper, every Tool requires writing the JSON Schema by hand
// AND a separate `validate` function — two sources of truth that can drift.
// With this helper, both are derived from the same zod schema.
//
// Uses zod's v4 API (`zod/v4`, available since zod 3.24) for native JSON
// Schema export. No extra dep; zod is already a peer for any consumer that
// wants this helper.

import { z, type ZodType } from 'zod/v4'
import type { Tool, ToolContext } from 'marco-harness'

export type ToolFromZodOptions<S extends ZodType> = {
  name: string
  description: string
  schema: S
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<string>
  category?: string
  permissionLevel?: 'auto' | 'confirm' | 'always-ask'
}

export function toolFromZod<S extends ZodType>(opts: ToolFromZodOptions<S>): Tool {
  const jsonSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>
  return {
    name: opts.name,
    description: opts.description,
    inputJsonSchema: jsonSchema,
    validate: (input) => opts.schema.parse(input),
    handler: opts.handler as Tool['handler'],
    ...(opts.category !== undefined && { category: opts.category }),
    ...(opts.permissionLevel !== undefined && { permissionLevel: opts.permissionLevel }),
  }
}

// Re-export zod's v4 z so consumers can do
//   import { toolFromZod, z } from 'marco-agent'
// without managing the zod/v4 import path themselves.
export { z }
