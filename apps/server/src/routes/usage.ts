import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MjDatabaseRepository } from '@mj/database';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: {
    repo: MjDatabaseRepository;
    settingsStore: RuntimeSettingsStore;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  app.get('/api/usage', { preHandler: deps.requireSession }, async () => {
    const settings = await deps.settingsStore.getPublicSettings();
    return deps.repo.getUsageSummary(settings.budget);
  });
}
