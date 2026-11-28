import { z } from 'zod';

export const DEFAULT_TOOL_CONFIRMATION_TIMEOUT_SECONDS = 20;
export const DEFAULT_TOOL_CONFIRMATION_TIMEOUT_MS =
  DEFAULT_TOOL_CONFIRMATION_TIMEOUT_SECONDS * 1000;

export type VoiceConfirmationDecision = 'approve' | 'cancel' | null;

const CANCEL_TOKENS = new Set([
  'no',
  'na',
  'nah',
  'nope',
  'nahi',
  'nahin',
  'cancel',
  'stop',
  'abort',
  'deny',
  'reject',
  'decline',
  'mat',
  'dont',
  "don't",
  'না',
  'নাহ',
  'নাহ্',
  'নাই',
  'থাক',
  'বাতিল',
  'করোনা',
  'नहीं',
  'नही',
  'ना',
  'मत',
  'रद्द',
  'रोको',
]);

const CANCEL_PHRASES = [
  'no thanks',
  'do not',
  'mat karo',
  'na karo',
  'করো না',
  'না করো',
  'বাদ দাও',
  'বাতিল করো',
  'मत करो',
  'रद्द करो',
  'बंद करो',
];

const APPROVE_TOKENS = new Set([
  'yes',
  'haan',
  'ha',
  'haa',
  'han',
  'yeah',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'confirm',
  'approve',
  'approved',
  'proceed',
  'karo',
  'koro',
  'হ্যাঁ',
  'হাঁ',
  'হা',
  'হ্যা',
  'হাঁজি',
  'জি',
  'করো',
  'কর',
  'হুম',
  'নিশ্চয়',
  'নিশ্চয়',
  'हाँ',
  'हां',
  'हा',
  'हांजी',
  'जी',
  'करो',
  'जरूर',
]);

const APPROVE_PHRASES = [
  'do it',
  'go ahead',
  'ji haan',
  'ji ha',
  'thik hai',
  'theek hai',
  'thik ache',
  'kar do',
  'kore dao',
  'kore daw',
  'জি হ্যাঁ',
  'করে দাও',
  'ঠিক আছে',
  'जी हाँ',
  'जी हां',
  'कर दो',
  'ठीक है',
];

function containsNormalizedPhrase(normalizedText: string, phrase: string): boolean {
  if (normalizedText === phrase) return true;
  if (normalizedText.startsWith(`${phrase} `)) return true;
  if (normalizedText.endsWith(` ${phrase}`)) return true;
  return normalizedText.includes(` ${phrase} `);
}

/**
 * Parses spoken confirmation responses across English, Bangla, Banglish, Hindi, and Hinglish.
 * Cancel phrases take precedence over approve phrases so negated forms (e.g. "করো না", "mat karo")
 * never trigger approval.
 */
export function parseVoiceConfirmationDecision(transcript: string): VoiceConfirmationDecision {
  const normalized = transcript
    .normalize('NFC')
    .replace(/[.,!?;:'"()[\]{}।॥\-–—…/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!normalized) return null;

  for (const phrase of CANCEL_PHRASES) {
    if (containsNormalizedPhrase(normalized, phrase)) {
      return 'cancel';
    }
  }

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.some((token) => CANCEL_TOKENS.has(token))) {
    return 'cancel';
  }

  for (const phrase of APPROVE_PHRASES) {
    if (containsNormalizedPhrase(normalized, phrase)) {
      return 'approve';
    }
  }

  if (tokens.some((token) => APPROVE_TOKENS.has(token))) {
    return 'approve';
  }

  return null;
}

export const ExecuteVoiceToolSchema = z.object({
  callId: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128),
  args: z.record(z.string(), z.unknown()).optional().default({}),
  conversationId: z.string().uuid().optional(),
  confirmed: z.boolean().optional(),
});

export const ConfirmToolActionSchema = z.object({
  confirmationId: z.string().min(1).max(128),
  decision: z.enum(['approve', 'cancel']).optional(),
  spokenText: z.string().max(400).optional(),
});
