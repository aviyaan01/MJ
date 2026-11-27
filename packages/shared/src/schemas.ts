import { z } from 'zod';
import { AppError, ErrorCodes } from './errors.js';

export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export const ResponseStyleSchema = z.enum(['balanced', 'concise', 'detailed']);
export const LanguageModeSchema = z.enum(['auto', 'en', 'bn', 'banglish']);

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(100).optional(),
});

export const UpdateConversationSchema = z.object({
  title: z.string().trim().min(1, 'Conversation title cannot be empty').max(120),
});

export const SendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty')
    .max(32000, 'Message exceeds maximum length of 32,000 characters'),
  model: z.string().trim().min(1).max(100).optional(),
  stream: z.boolean().optional(),
});

export const RegenerateMessageSchema = z.object({
  model: z.string().trim().min(1).max(100).optional(),
  stream: z.boolean().optional(),
});

export const VoiceClientSecretRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(100).optional(),
  voice: z.string().trim().min(1).max(60).optional(),
  languageMode: LanguageModeSchema.optional(),
});

export const SaveVoiceTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(32000),
  status: z.enum(['completed', 'aborted', 'error']).optional(),
  model: z.string().trim().min(1).max(100).optional(),
});

export const RecordVoiceUsageSchema = z.object({
  conversationId: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100),
  durationSeconds: z.number().min(0).max(86400),
  status: z.enum(['success', 'error', 'aborted']),
  errorCode: z.string().trim().max(80).optional(),
});

export const TtsRequestSchema = z.object({
  text: z.string().trim().min(1, 'Text cannot be empty').max(8000),
  voiceId: z.string().trim().min(1).max(60).optional(),
  languageMode: LanguageModeSchema.optional(),
});

export const UpdateSettingsSchema = z.object({
  activeModel: z.string().trim().min(1).max(100).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  responseStyle: ResponseStyleSchema.optional(),
  maxOutputTokens: z.number().int().min(128).max(32768).optional(),
  timeoutMs: z.number().int().min(5000).max(180000).optional(),
  streamResponses: z.boolean().optional(),
  reducedMotionOverride: z.enum(['system', 'reduce', 'normal']).optional(),
  compactDensity: z.boolean().optional(),
  budget: z
    .object({
      softCapUsd: z.number().min(0).max(10000).optional(),
      hardCapUsd: z.number().min(0).max(10000).optional(),
      inputRatePerMillionUsd: z.number().min(0).max(500).optional(),
      outputRatePerMillionUsd: z.number().min(0).max(500).optional(),
      cachedInputRatePerMillionUsd: z.number().min(0).max(500).optional(),
      voiceRatePerMinuteUsd: z.number().min(0).max(10).optional(),
      ttsRatePerMillionCharsUsd: z.number().min(0).max(500).optional(),
      sttRatePerHourUsd: z.number().min(0).max(100).optional(),
    })
    .optional(),
  voice: z
    .object({
      voiceModel: z.string().trim().min(1).max(100).optional(),
      voiceId: z.string().trim().min(1).max(60).optional(),
      speakingRate: z.number().min(0.7).max(1.6).optional(),
      volume: z.number().min(0).max(1).optional(),
      autoPlayback: z.boolean().optional(),
      voiceOutputEnabled: z.boolean().optional(),
      languageMode: LanguageModeSchema.optional(),
    })
    .optional(),
});

export const LoginSchema = z.object({
  passcode: z.string().max(256).optional(),
});

export function validateInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join('.') || 'input'}: ${firstIssue.message}`
      : 'Invalid request input.';
    throw new AppError({
      code: ErrorCodes.VALIDATION_ERROR,
      category: 'validation',
      statusCode: 400,
      message,
    });
  }
  return result.data;
}
