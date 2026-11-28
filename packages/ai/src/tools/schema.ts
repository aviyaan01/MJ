import { z } from '@mj/shared';

function sanitizeOpenAiSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeOpenAiSchemaNode(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$schema') continue;
    out[key] = sanitizeOpenAiSchemaNode(value);
  }
  return out;
}

const GEMINI_TYPE_MAP: Record<string, string> = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
};

function convertNodeForGeminiLive(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => convertNodeForGeminiLive(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$schema' || key === 'additionalProperties') continue;
    if (key === 'type' && typeof value === 'string') {
      out[key] = GEMINI_TYPE_MAP[value.toLowerCase()] ?? value.toUpperCase();
    } else {
      out[key] = convertNodeForGeminiLive(value);
    }
  }
  return out;
}

/**
 * Generates an OpenAI-compatible JSON Schema parameters object from a Zod object schema.
 */
export function zodToToolJsonSchema(
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>,
): Record<string, unknown> {
  const raw = z.toJSONSchema(schema);
  const sanitized = sanitizeOpenAiSchemaNode(raw);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { type: 'object', properties: {} };
}

/**
 * Converts a JSON Schema object into Gemini Live `FunctionDeclaration.parameters`
 * format (uppercase schema types, omitting empty parameters or `$schema`/`additionalProperties`).
 */
export function toGeminiLiveParametersSchema(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const props = jsonSchema.properties;
  if (
    !props ||
    typeof props !== 'object' ||
    Array.isArray(props) ||
    Object.keys(props as Record<string, unknown>).length === 0
  ) {
    return undefined;
  }
  const converted = convertNodeForGeminiLive(jsonSchema);
  return converted && typeof converted === 'object' && !Array.isArray(converted)
    ? (converted as Record<string, unknown>)
    : undefined;
}
