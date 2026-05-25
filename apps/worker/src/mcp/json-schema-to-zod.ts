/**
 * Minimal JSON-Schema → Zod converter for the proxied-tools registration
 * path. The MCP SDK's `registerTool` accepts Zod schemas only; upstream
 * tools advertise plain JSON-Schema, so we convert just enough to keep
 * the round-trip faithful (object/string/number/boolean/array/enum,
 * required, optionality, allOf via merge).
 *
 * Anything unrecognised falls back to `z.any()` — the upstream still
 * validates on the wire, but the SDK won't reject typed args.
 *
 * We return a `ZodRawShape` (record of zod schemas, as used by the
 * built-in tools in `session-do.ts`) when the root is an object schema,
 * otherwise a single `ZodTypeAny`. Callers branch on the result.
 */

import { z, type ZodTypeAny, type ZodRawShape } from 'zod'

interface JsonSchemaNode {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode | JsonSchemaNode[]
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchemaNode[]
  anyOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  description?: string
  default?: unknown
  format?: string
}

export interface ConvertedSchema {
  /** `shape` is set when the root is a non-empty object schema. */
  shape: ZodRawShape | null
  /** Always set: full Zod schema for the root. Used as a fallback. */
  zod: ZodTypeAny
}

export function jsonSchemaToZod(input: unknown): ConvertedSchema {
  const node = (input ?? {}) as JsonSchemaNode
  if (isObjectSchema(node)) {
    const shape = objectShape(node)
    return { shape, zod: z.object(shape).passthrough() }
  }
  return { shape: null, zod: nodeToZod(node) }
}

function isObjectSchema(node: JsonSchemaNode): boolean {
  if (Array.isArray(node.type)) return node.type.includes('object')
  if (node.type === 'object') return true
  // Some servers omit `type` but ship `properties` — treat as object.
  return !!node.properties
}

function objectShape(node: JsonSchemaNode): ZodRawShape {
  const required = new Set(node.required ?? [])
  const shape: ZodRawShape = {}
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    let schema = nodeToZod(child)
    if (child.description) schema = schema.describe(child.description)
    if (!required.has(key)) schema = schema.optional()
    shape[key] = schema
  }
  return shape
}

function nodeToZod(node: JsonSchemaNode): ZodTypeAny {
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const allStrings = node.enum.every((v) => typeof v === 'string')
    if (allStrings) {
      return z.enum(node.enum as [string, ...string[]])
    }
    const literals = node.enum.map((v) => z.literal(v as never)) as unknown as ZodTypeAny[]
    return z.union(literals as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]])
  }
  if (node.const !== undefined) return z.literal(node.const as never)

  if (Array.isArray(node.allOf)) {
    // Merge object subschemas into a single shape; non-object members
    // fall through to z.any().
    const merged: ZodRawShape = {}
    for (const member of node.allOf) {
      if (isObjectSchema(member)) Object.assign(merged, objectShape(member))
    }
    return z.object(merged).passthrough()
  }
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
    const members = (node.oneOf ?? node.anyOf ?? []).map(nodeToZod)
    const [first, second, ...rest] = members
    if (!first) return z.any()
    if (!second) return first
    return z.union([first, second, ...rest])
  }

  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : []
  if (types.length > 1) {
    return z.union(
      types.map((t) => nodeToZod({ ...node, type: t })) as [
        ZodTypeAny,
        ZodTypeAny,
        ...ZodTypeAny[]
      ]
    )
  }

  switch (types[0]) {
    case 'string':
      return z.string()
    case 'integer':
      return z.number().int()
    case 'number':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array': {
      const itemNode = Array.isArray(node.items) ? node.items[0] : node.items
      return z.array(itemNode ? nodeToZod(itemNode) : z.any())
    }
    case 'object':
      return z.object(objectShape(node)).passthrough()
    default:
      return z.any()
  }
}
