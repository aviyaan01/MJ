import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_SETTINGS } from '@mj/shared';
import { MjDatabaseRepository, createDatabase, type MjDatabaseHandle } from '@mj/database';

describe('SQLite + Drizzle Database Layer', () => {
  const handles: MjDatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it('persists conversations, messages, search, rename, delete, and usage summaries', async () => {
    const handle = createDatabase(':memory:');
    handles.push(handle);
    expect(handle.ping()).toBe(true);

    const repo = new MjDatabaseRepository(handle);
    const conv = await repo.createConversation({
      title: 'Banglish Project Plan',
      model: 'grok-4.7',
    });

    await repo.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Amar ekta project idea ache',
      status: 'completed',
    });

    await repo.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'Great! Tell me about your idea.',
      status: 'completed',
      model: 'grok-4.7',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cachedTokens: 0,
        totalTokens: 150,
      },
      estimatedCostUsd: 0.0005,
      latencyMs: 320,
    });

    // Incomplete streaming message should NOT enter prompt context turns
    await repo.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'partial',
      status: 'streaming',
    });

    const turns = await repo.getContextTurns(conv.id);
    expect(turns).toEqual([
      { role: 'user', content: 'Amar ekta project idea ache' },
      { role: 'assistant', content: 'Great! Tell me about your idea.' },
    ]);

    const searched = await repo.listConversations('Banglish');
    expect(searched).toHaveLength(1);
    expect(searched[0]?.messageCount).toBe(3);

    const renamed = await repo.renameConversation(conv.id, 'Updated Title');
    expect(renamed.title).toBe('Updated Title');

    await repo.recordUsageLog({
      conversationId: conv.id,
      model: 'grok-4.7',
      status: 'success',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cachedTokens: 0,
        totalTokens: 150,
      },
      estimatedCostUsd: 0.0005,
      latencyMs: 320,
    });

    const usage = await repo.getUsageSummary(DEFAULT_BUDGET_SETTINGS);
    expect(usage.today.requestCount).toBe(1);
    expect(usage.today.totalTokens).toBe(150);
    expect(usage.budgetStatus.level).toBe('ok');

    const deleted = await repo.deleteConversation(conv.id);
    expect(deleted).toBe(true);
    expect(await repo.getConversationDetail(conv.id)).toBeNull();
  });
});
