import type { FastifyInstance } from 'fastify';
import { AppError, ErrorCodes, LoginSchema, validateInput, type AuthSessionDTO } from '@mj/shared';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  setSessionCookie,
  signSessionToken,
  verifyPasscodeConstantTime,
  verifySessionToken,
} from '../auth.js';
import type { ServerConfig } from '../config.js';

export function registerAuthRoutes(app: FastifyInstance, config: ServerConfig): void {
  app.get('/api/auth/session', async (request) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    const session = verifySessionToken(token, config.authSecret);

    const dto: AuthSessionDTO = {
      authenticated: session !== null,
      passcodeRequired: config.passcodeRequired,
      mode: config.passcodeRequired ? 'passcode' : 'local-dev',
      appEnv: config.appEnv,
    };

    return dto;
  });

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 15,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const body = validateInput(LoginSchema, request.body ?? {});

      if (config.passcodeRequired) {
        const provided = body.passcode ?? '';
        if (!verifyPasscodeConstantTime(provided, config.accessPasscode)) {
          throw new AppError({
            code: ErrorCodes.UNAUTHORIZED,
            category: 'auth',
            statusCode: 401,
            message: 'Invalid access passcode.',
          });
        }
      } else if (config.appEnv === 'production') {
        throw new AppError({
          code: ErrorCodes.UNAUTHORIZED,
          category: 'auth',
          statusCode: 401,
          message: 'Passcode authentication is required in production.',
        });
      }

      const mode = config.passcodeRequired ? 'passcode' : 'local-dev';
      const token = signSessionToken(mode, config.authSecret);
      setSessionCookie(request, reply, token, config);

      const dto: AuthSessionDTO = {
        authenticated: true,
        passcodeRequired: config.passcodeRequired,
        mode,
        appEnv: config.appEnv,
      };
      return dto;
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    clearSessionCookie(request, reply, config);
    const dto: AuthSessionDTO = {
      authenticated: false,
      passcodeRequired: config.passcodeRequired,
      mode: config.passcodeRequired ? 'passcode' : 'local-dev',
      appEnv: config.appEnv,
    };
    return dto;
  });
}
