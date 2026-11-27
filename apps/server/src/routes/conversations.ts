import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  CreateConversationSchema,
  ErrorCodes,
  RegenerateMessageSchema,
  SaveVoiceTurnSchema,
  SendMessageSchema,
  UpdateConversationSchema,
  estimateResponseCostUsd,
  evaluateBudgetStatus,
  validateInput,
  type AiProviderId,
  type ChatStreamEvent,
  type MessageDTO,
} from '@mj/shared';
import {
  ProviderRouterClient,
  XaiResponsesClient,
  buildMjSystemPrompt,
  isLoopbackBaseUrl,
} from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { AlertMonitor } from '../alerting.js';
import type { ServerConfig } from '../config.js';
import type { PermissionsStore } from '../permissionsStore.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export interface ConversationRouteDeps {
  config: ServerConfig;
  repo: MjDatabaseRepository;
  settingsStore: RuntimeSettingsStore;
  permissionsStore: PermissionsStore;
  xaiClient: XaiResponsesClient;
  providerRouter?: ProviderRouterClient;
  alertMonitor?: AlertMonitor;
  requireSession: (request: FastifyRequest) => Promise<void>;
}

function buildConversationTitleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 52) return collapsed;
  return `${collapsed.slice(0, 49).trimEnd()}…`;
}

function writeSseEvent(reply: FastifyReply, event: ChatStreamEvent): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function beginSseStream(reply: FastifyReply): void {
  reply.hijack();
  const existingHeaders = reply.getHeaders();
  const safeHeaders: Record<string, string | number | readonly string[]> = {};
  for (const [key, value] of Object.entries(existingHeaders)) {
    if (value !== undefined) {
      safeHeaders[key] = value as string | number | readonly string[];
    }
  }
  reply.raw.writeHead(200, {
    ...safeHeaders,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

async function prepareChatPreflight(params: {
  requestId: string;
  deps: ConversationRouteDeps;
  modelOverride?: string;
  providerOverride?: AiProviderId;
}): Promise<{
  activeProvider: AiProviderId;
  activeModel: string;
  freeOnly: boolean;
  localOnly: boolean;
}> {
  const { requestId, deps, modelOverride, providerOverride } = params;
  if (deps.providerRouter) {
    await deps.providerRouter.refreshLocalOllamaModels(false);
  }

  const anyReady = deps.providerRouter
    ? deps.providerRouter.hasAnyConfiguredProvider()
    : deps.config.apiKeyConfigured;
  if (!anyReady) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
      requestId,
    });
  }

  const settings = await deps.settingsStore.getPublicSettings();
  const activeProvider = providerOverride ?? settings.activeProvider ?? 'gemini';
  const activeModel = modelOverride?.trim() || settings.activeModel;

  const fallbackXaiUrl = `${deps.config.xaiBaseUrl.replace(/\/+$/, '')}/responses`;
  const preview = deps.providerRouter?.resolveRoutingPreview(activeProvider, activeModel) ?? null;
  const targetEndpoint = preview?.primary?.endpointUrl ?? fallbackXaiUrl;
  const targetName = preview?.primary?.name ?? 'xAI Grok';

  let localOnly = false;
  const permissions = await deps.permissionsStore.getPermissions();
  if (!permissions.externalWebServices) {
    const canRunLocalLoopback = preview
      ? preview.hasLocalCandidate
      : isLoopbackBaseUrl(deps.config.xaiBaseUrl);
    if (!canRunLocalLoopback) {
      await deps.repo.recordAuditLog({
        capability: 'externalWebServices',
        action: `Blocked outbound ${targetName} API chat request`,
        target: targetEndpoint,
        outcome: 'denied',
        source: 'server',
        detail: 'externalWebServices is disabled in Privacy & Permissions.',
      });
      throw new AppError({
        code: ErrorCodes.PERMISSION_DENIED,
        category: 'privacy',
        statusCode: 403,
        requestId,
        message: 'External AI requests are disabled in Privacy & Permissions.',
      });
    }
    localOnly = true;
  }

  let freeOnly = false;
  const usageSummary = await deps.repo.getUsageSummary(settings.budget);
  if (usageSummary.budgetStatus.level === 'hard_cap_reached') {
    const hasFreeEligible = preview
      ? preview.candidates.some((c) => c.isFree && (!localOnly || c.isLocal))
      : localOnly && isLoopbackBaseUrl(deps.config.xaiBaseUrl);
    if (!hasFreeEligible) {
      throw new AppError({
        code: ErrorCodes.BUDGET_EXCEEDED,
        category: 'budget',
        statusCode: 429,
        requestId,
      });
    }
    freeOnly = true;
  }

  return { activeProvider, activeModel, freeOnly, localOnly };
}

async function streamAssistantTurn(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  deps: ConversationRouteDeps;
  conversationId: string;
  userMessageId: string;
  modelOverride?: string;
  providerOverride?: AiProviderId;
  freeOnly?: boolean;
  localOnly?: boolean;
  streamOverride?: boolean;
  updatedTitle?: string;
}): Promise<void> {
  const { request, reply, deps, conversationId, userMessageId } = params;
  const settings = await deps.settingsStore.getPublicSettings();
  const activeProvider = params.providerOverride ?? settings.activeProvider ?? 'gemini';
  const activeModel = params.modelOverride?.trim() || settings.activeModel;
  const useStreaming = params.streamOverride ?? settings.streamResponses;

  const assistantPlaceholder = await deps.repo.addMessage({
    conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    model: activeModel,
  });

  const contextTurns = await deps.repo.getContextTurns(conversationId, 30);
  const instructions = buildMjSystemPrompt({
    assistantName: settings.assistantName,
    responseStyle: settings.responseStyle,
    languageMode: settings.voice.languageMode,
  });

  beginSseStream(reply);

  const abortController = new AbortController();
  let streamCompleted = false;

  reply.raw.on('close', () => {
    if (!streamCompleted) {
      abortController.abort();
    }
  });

  writeSseEvent(reply, {
    type: 'meta',
    conversationId,
    userMessageId,
    assistantMessageId: assistantPlaceholder.id,
    model: activeModel,
    ...(params.updatedTitle ? { conversationTitle: params.updatedTitle } : {}),
  });

  let accumulated = '';
  const startedAt = Date.now();

  try {
    const result = deps.providerRouter
      ? await deps.providerRouter.createResponse({
          provider: activeProvider,
          model: activeModel,
          instructions,
          input: contextTurns,
          reasoningEffort: settings.reasoningEffort,
          maxOutputTokens: settings.maxOutputTokens,
          stream: useStreaming,
          timeoutMs: settings.timeoutMs,
          freeOnly: params.freeOnly,
          localOnly: params.localOnly,
          signal: abortController.signal,
          onStatus: (phase, detail) => {
            writeSseEvent(reply, { type: 'status', phase, detail });
          },
          onDelta: (delta) => {
            accumulated += delta;
            writeSseEvent(reply, { type: 'delta', text: delta });
          },
        })
      : {
          ...(await deps.xaiClient.createResponse({
            model: activeModel,
            instructions,
            input: contextTurns,
            reasoningEffort: settings.reasoningEffort,
            maxOutputTokens: settings.maxOutputTokens,
            stream: useStreaming,
            timeoutMs: settings.timeoutMs,
            signal: abortController.signal,
            onStatus: (phase, detail) => {
              writeSseEvent(reply, { type: 'status', phase, detail });
            },
            onDelta: (delta) => {
              accumulated += delta;
              writeSseEvent(reply, { type: 'delta', text: delta });
            },
          })),
          isFree: false,
        };

    const finalText = result.text || accumulated;
    const costUsd = result.isFree ? 0 : estimateResponseCostUsd(result.usage, settings.budget);

    const savedAssistant = await deps.repo.updateMessage(assistantPlaceholder.id, {
      content: finalText,
      status: 'completed',
      model: result.model,
      xaiResponseId: result.responseId ?? null,
      usage: result.usage,
      latencyMs: result.latencyMs,
      estimatedCostUsd: costUsd,
      errorCode: null,
    });

    await deps.repo.touchConversation(conversationId, { model: result.model });

    await deps.repo.recordUsageLog({
      conversationId,
      messageId: assistantPlaceholder.id,
      model: result.model,
      status: 'success',
      usage: result.usage,
      estimatedCostUsd: costUsd,
      latencyMs: result.latencyMs,
    });

    const usageSummary = await deps.repo.getUsageSummary(settings.budget);
    const budgetStatus = evaluateBudgetStatus(
      usageSummary.month.estimatedCostUsd,
      usageSummary.today.estimatedCostUsd,
      settings.budget,
    );

    void deps.alertMonitor?.recordApiOutcome({ ok: true });
    void deps.alertMonitor?.notifyDailyBudgetCrossed(budgetStatus);

    writeSseEvent(reply, {
      type: 'usage',
      usage: result.usage,
      estimatedCostUsd: costUsd,
      latencyMs: result.latencyMs,
      budgetStatus,
    });

    const detail = await deps.repo.getConversationDetail(conversationId);
    if (savedAssistant && detail) {
      writeSseEvent(reply, {
        type: 'done',
        message: savedAssistant,
        conversation: detail.conversation,
      });
    }

    streamCompleted = true;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const appErr =
      err instanceof AppError
        ? err
        : new AppError({
            code: ErrorCodes.INTERNAL_ERROR,
            category: 'internal',
            cause: err,
          });
    appErr.requestId = request.id;

    if (appErr.code === ErrorCodes.ABORTED) {
      await deps.repo.updateMessage(assistantPlaceholder.id, {
        content: accumulated,
        status: 'aborted',
        model: activeModel,
        latencyMs,
        errorCode: ErrorCodes.ABORTED,
      });

      await deps.repo.recordUsageLog({
        conversationId,
        messageId: assistantPlaceholder.id,
        model: activeModel,
        status: 'aborted',
        latencyMs,
        errorCode: ErrorCodes.ABORTED,
      });
    } else {
      request.log.error(
        {
          reqId: request.id,
          code: appErr.code,
          category: appErr.category,
          statusCode: appErr.statusCode,
          ...(appErr.upstreamDiagnostic
            ? { upstreamError: appErr.upstreamDiagnostic }
            : {}),
        },
        'Grok chat request failed',
      );

      const savedPartial: MessageDTO | null = await deps.repo.updateMessage(
        assistantPlaceholder.id,
        {
          content: accumulated,
          status: 'error',
          model: activeModel,
          latencyMs,
          errorCode: appErr.code,
        },
      );

      await deps.repo.recordUsageLog({
        conversationId,
        messageId: assistantPlaceholder.id,
        model: activeModel,
        status: 'error',
        latencyMs,
        errorCode: appErr.code,
      });

      void deps.alertMonitor?.recordApiOutcome({ ok: false, code: appErr.code });

      writeSseEvent(reply, {
        type: 'error',
        error: appErr.toPayload(),
        ...(savedPartial ? { partialMessage: savedPartial } : {}),
      });
    }

    streamCompleted = true;
  } finally {
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRouteDeps,
): void {
  app.get('/api/conversations', { preHandler: deps.requireSession }, async (request) => {
    const query = request.query as { q?: string };
    // Clamp search query length to prevent sending unbounded strings into the DB LIKE expression.
    const rawQ = typeof query?.q === 'string' ? query.q.slice(0, 200).trim() : undefined;
    const conversations = await deps.repo.listConversations(rawQ || undefined);
    return { conversations };
  });

  app.post('/api/conversations', { preHandler: deps.requireSession }, async (request, reply) => {
    const body = validateInput(CreateConversationSchema, request.body ?? {});
    const settings = await deps.settingsStore.getPublicSettings();
    const conversation = await deps.repo.createConversation({
      title: body.title,
      model: body.model ?? settings.activeModel,
    });
    return reply.status(201).send({ conversation });
  });

  app.get('/api/conversations/:id', { preHandler: deps.requireSession }, async (request) => {
    const { id } = request.params as { id: string };
    const detail = await deps.repo.getConversationDetail(id);
    if (!detail) {
      throw new AppError({
        code: ErrorCodes.NOT_FOUND,
        category: 'validation',
        statusCode: 404,
        message: 'Conversation not found.',
      });
    }
    return detail;
  });

  app.patch('/api/conversations/:id', { preHandler: deps.requireSession }, async (request) => {
    const { id } = request.params as { id: string };
    const body = validateInput(UpdateConversationSchema, request.body ?? {});
    const conversation = await deps.repo.renameConversation(id, body.title);
    return { conversation };
  });

  app.delete('/api/conversations/:id', { preHandler: deps.requireSession }, async (request) => {
    const { id } = request.params as { id: string };
    const deleted = await deps.repo.deleteConversation(id);
    if (!deleted) {
      throw new AppError({
        code: ErrorCodes.NOT_FOUND,
        category: 'validation',
        statusCode: 404,
        message: 'Conversation not found.',
      });
    }
    return { deleted: true, id };
  });

  app.post(
    '/api/conversations/:id/messages',
    { preHandler: deps.requireSession },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateInput(SendMessageSchema, request.body ?? {});

      const existing = await deps.repo.getConversationDetail(id);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          category: 'validation',
          statusCode: 404,
          message: 'Conversation not found.',
        });
      }

      const preflight = await prepareChatPreflight({
        requestId: request.id,
        deps,
        modelOverride: body.model,
        providerOverride: body.provider,
      });

      const shouldAutoTitle =
        existing.conversation.title === 'New conversation' && existing.messages.length === 0;
      const updatedTitle = shouldAutoTitle
        ? buildConversationTitleFromPrompt(body.content)
        : undefined;

      if (updatedTitle) {
        await deps.repo.touchConversation(id, { title: updatedTitle });
      }

      const userMessage = await deps.repo.addMessage({
        conversationId: id,
        role: 'user',
        content: body.content,
        status: 'completed',
      });

      await streamAssistantTurn({
        request,
        reply,
        deps,
        conversationId: id,
        userMessageId: userMessage.id,
        modelOverride: preflight.activeModel,
        providerOverride: preflight.activeProvider,
        freeOnly: preflight.freeOnly,
        localOnly: preflight.localOnly,
        streamOverride: body.stream,
        updatedTitle,
      });
    },
  );

  app.post(
    '/api/conversations/:id/regenerate',
    { preHandler: deps.requireSession },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateInput(RegenerateMessageSchema, request.body ?? {});

      const existing = await deps.repo.getConversationDetail(id);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          category: 'validation',
          statusCode: 404,
          message: 'Conversation not found.',
        });
      }

      const preflight = await prepareChatPreflight({
        requestId: request.id,
        deps,
        modelOverride: body.model,
        providerOverride: body.provider,
      });

      const msgs = existing.messages;
      const lastMsg = msgs[msgs.length - 1];
      if (!lastMsg) {
        throw new AppError({
          code: ErrorCodes.VALIDATION_ERROR,
          category: 'validation',
          statusCode: 400,
          message: 'No prompt found in this conversation to regenerate.',
        });
      }

      let targetUserMessage = lastMsg.role === 'user' ? lastMsg : undefined;
      if (lastMsg.role === 'assistant') {
        await deps.repo.deleteMessage(lastMsg.id);
        targetUserMessage = [...msgs]
          .reverse()
          .find((m) => m.role === 'user' && m.id !== lastMsg.id);
      }

      if (!targetUserMessage) {
        throw new AppError({
          code: ErrorCodes.VALIDATION_ERROR,
          category: 'validation',
          statusCode: 400,
          message: 'No user message available to regenerate.',
        });
      }

      await streamAssistantTurn({
        request,
        reply,
        deps,
        conversationId: id,
        userMessageId: targetUserMessage.id,
        modelOverride: preflight.activeModel,
        providerOverride: preflight.activeProvider,
        freeOnly: preflight.freeOnly,
        localOnly: preflight.localOnly,
        streamOverride: body.stream,
      });
    },
  );

  /**
   * Persists voice transcripts from Grok Realtime Voice into the shared
   * conversation manager so voice and text share unified context & history.
   */
  app.post(
    '/api/conversations/:id/voice-turns',
    { preHandler: deps.requireSession },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateInput(SaveVoiceTurnSchema, request.body ?? {});

      const existing = await deps.repo.getConversationDetail(id);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          category: 'validation',
          statusCode: 404,
          message: 'Conversation not found.',
        });
      }

      const settings = await deps.settingsStore.getPublicSettings();
      const shouldAutoTitle =
        body.role === 'user' &&
        existing.conversation.title === 'New conversation' &&
        existing.messages.length === 0;
      const updatedTitle = shouldAutoTitle
        ? buildConversationTitleFromPrompt(body.content)
        : undefined;

      if (updatedTitle) {
        await deps.repo.touchConversation(id, { title: updatedTitle });
      }

      const message = await deps.repo.addMessage({
        conversationId: id,
        role: body.role,
        content: body.content,
        channel: 'voice',
        status: body.status ?? 'completed',
        model: body.model ?? settings.voice.voiceModel,
      });

      const updated = await deps.repo.getConversationDetail(id);
      return reply.status(201).send({
        message,
        conversation: updated?.conversation ?? existing.conversation,
      });
    },
  );
}
