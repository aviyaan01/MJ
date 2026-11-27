import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UpdateSettingsSchema, validateInput } from '@mj/shared';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: {
    settingsStore: RuntimeSettingsStore;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  app.get('/api/settings', { preHandler: deps.requireSession }, async () => {
    return deps.settingsStore.getPublicSettings();
  });

  app.patch('/api/settings', { preHandler: deps.requireSession }, async (request) => {
    const patch = validateInput(UpdateSettingsSchema, request.body ?? {});
    return deps.settingsStore.updateSettings(patch);
  });
}
