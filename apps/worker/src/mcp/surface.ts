/**
 * The prompt/resource registration surface both MCP SDK generations share.
 *
 * `/mcp` is served by two lanes on two SDKs (v1 `@modelcontextprotocol/sdk`
 * for the session lane, v2 `@modelcontextprotocol/server` for the stateless
 * lane). Their `McpServer` classes are different types, but for what we
 * register — prompts, resources, resource templates, one extension
 * capability — the method shapes are the same. Code that registers those
 * (skills, docs, the draft-skill prompt) is written once against this
 * interface; each lane adapts its own server with `surfaceOf`, handing in its
 * own SDK's `ResourceTemplate` class.
 *
 * Tools do NOT go through here: the two SDKs differ there (callback shape,
 * schema types), so built-ins have per-SDK adapters in `mcp/builtins/`.
 */

import type { z } from 'zod'

export interface ResourceListing {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface ResourceContents {
  contents: Array<{ uri: string; mimeType?: string; text: string }>
}

export interface PromptMessages {
  description?: string
  messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>
}

/** An opaque handle to a lane's own `ResourceTemplate` instance. */
export type ResourceTemplateHandle = { readonly __template: unique symbol }

export interface McpSurface {
  registerPrompt<S extends z.ZodRawShape>(
    name: string,
    config: { title?: string; description?: string; argsSchema?: S },
    cb: (args: z.infer<z.ZodObject<S>>) => PromptMessages | Promise<PromptMessages>
  ): void
  registerResource(
    name: string,
    uriOrTemplate: string | ResourceTemplateHandle,
    config: { title?: string; description?: string; mimeType?: string },
    read: (
      uri: URL,
      variables: Record<string, string | string[] | undefined>
    ) => Promise<ResourceContents>
  ): void
  /** A URI template whose `list` enumerates the concrete resources. */
  resourceTemplate(
    uriTemplate: string,
    list: () => Promise<{ resources: ResourceListing[] }>
  ): ResourceTemplateHandle
  /** Advertise an MCP extension (empty object = supported, no settings). */
  registerExtension(id: string): void
}

/** What `surfaceOf` needs from either SDK's `McpServer`. */
interface ServerLike {
  registerPrompt(...args: never[]): unknown
  registerResource(...args: never[]): unknown
  server: { registerCapabilities(caps: never): void }
}

type TemplateCtor = new (
  uriTemplate: string,
  callbacks: { list: () => Promise<{ resources: ResourceListing[] }> }
) => object

/**
 * Adapt one lane's server. The casts are the whole point of this module:
 * they are made once, here, instead of at every registration site. Runtime
 * behaviour is each SDK's own; the lanes' integration tests exercise it.
 */
export function surfaceOf(server: ServerLike, ResourceTemplate: TemplateCtor): McpSurface {
  type Loose = (...args: unknown[]) => unknown
  const registerPrompt = (server.registerPrompt as unknown as Loose).bind(server)
  const registerResource = (server.registerResource as unknown as Loose).bind(server)
  return {
    registerPrompt: (name, config, cb) => {
      registerPrompt(name, config, cb)
    },
    registerResource: (name, uriOrTemplate, config, read) => {
      registerResource(name, uriOrTemplate, config, read)
    },
    resourceTemplate: (uriTemplate, list) =>
      new ResourceTemplate(uriTemplate, { list }) as unknown as ResourceTemplateHandle,
    registerExtension: (id) => {
      ;(server.server.registerCapabilities as unknown as Loose).call(server.server, {
        extensions: { [id]: {} }
      })
    }
  }
}

/** First value of a template variable (`{id}` may expand to a list). */
export function firstVar(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}
