import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { Services } from '../services';

export type Role = 'owner' | 'member';
export type RunKind = 'chat' | 'job' | 'mission' | 'subagent';

export interface ReplyTarget {
  channel: string;
  to: string;
}

export interface ToolContext {
  conversationId: string;
  role: Role;
  runKind: RunKind;
  /** Where replies for this run go; background runs have none and notify proactively. */
  replyTarget?: ReplyTarget;
  signal: AbortSignal;
  services: Services;
  /** Set when a background run sends something, so the runner knows the owner already heard. */
  sentMessages: string[];
}

type ResultBlock =
  | Anthropic.Beta.Messages.BetaTextBlockParam
  | Anthropic.Beta.Messages.BetaImageBlockParam
  | Anthropic.Beta.Messages.BetaRequestDocumentBlock;

export type ToolResultContent = string | ResultBlock[];

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Owner-only tools never load for members (email, calendar, calls…). */
  ownerOnly?: boolean;
  /** Read-only tools are the ones sub-agents get. */
  readOnly?: boolean;
  /**
   * Return a one-line description of what's about to happen when this call
   * needs the owner's explicit OK; return null to run it straight away.
   */
  approval?: (input: z.infer<S>, ctx: ToolContext) => Promise<string | null> | string | null;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResultContent>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Thrown by tools for expected, user-facing failures (shown to Claude as is_error). */
export class ToolError extends Error {}

export function toApiTool(def: ToolDef): Anthropic.Beta.Messages.BetaTool {
  const schema = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: def.name,
    description: def.description,
    input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    eager_input_streaming: true,
  };
}
