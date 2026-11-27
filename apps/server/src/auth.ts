import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ErrorCodes } from '@mj/shared';
import type { ServerConfig } from './config.js';

export const SESSION_COOKIE_NAME = 'mj_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface SessionPayload {
  sid: string;
  mode: 'passcode' | 'local-dev';
  iat: number;
  exp: number;
}

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function verifyPasscodeConstantTime(input: string, expected: string): boolean {
  if (!expected) return false;
  return timingSafeEqual(sha256Buffer(input), sha256Buffer(expected));
}

export function signSessionToken(
  mode: SessionPayload['mode'],
  authSecret: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sid: randomUUID(),
    mode,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', authSecret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(
  token: string | undefined,
  authSecret: string,
): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) return null;

  const expectedSig = createHmac('sha256', authSecret)
    .update(encodedPayload)
    .digest('base64url');

  const providedBuf = Buffer.from(providedSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as SessionPayload;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!parsed.sid || typeof parsed.exp !== 'number' || parsed.exp <= nowSec) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.split(':')[0]?.trim().toLowerCase() ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function shouldUseSecureCookie(
  request: FastifyRequest,
  config: ServerConfig,
): boolean {
  if (config.cookieSameSite === 'none') return true;
  if (config.appEnv !== 'production') return false;
  if (request.protocol === 'https') return true;
  return !isLoopbackHost(request.hostname);
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  config: ServerConfig,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    path: '/',
    secure: shouldUseSecureCookie(request, config),
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    path: '/',
    secure: shouldUseSecureCookie(request, config),
  });
}

export function createSessionGuard(config: ServerConfig) {
  const allowedOriginSet = new Set(config.corsOrigins);

  return async function requireSession(request: FastifyRequest): Promise<void> {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    const session = verifySessionToken(token, config.authSecret);

    if (!session) {
      throw new AppError({
        code: ErrorCodes.UNAUTHORIZED,
        category: 'auth',
        statusCode: 401,
        message: 'Session missing or expired. Unlock MJ Assistant to continue.',
      });
    }

    // Origin check on mutating requests as CSRF defense-in-depth
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = request.headers.origin;
      if (origin && !allowedOriginSet.has(origin)) {
        throw new AppError({
          code: ErrorCodes.UNAUTHORIZED,
          category: 'auth',
          statusCode: 403,
          message: 'Cross-origin request blocked.',
        });
      }
    }
  };
}
