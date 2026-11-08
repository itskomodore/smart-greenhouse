import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from './errors.js';

/** Extracts the token from `Authorization: Bearer <token>`; null when absent or malformed. */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

/**
 * Constant-time comparison. Both sides are hashed first so the comparison runs over equal-length
 * buffers and leaks neither the token length nor a prefix match timing.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * onRequest hook for write routes. Runs before body parsing, so an unauthenticated caller gets 401
 * regardless of body validity. With no token configured, writes are refused with 503.
 */
export function requireBearer(expectedToken: string) {
  return async function auth(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    if (expectedToken.length === 0) {
      return reply
        .code(503)
        .send(errorBody('auth_not_configured', 'API_TOKEN is not set; write endpoints are disabled'));
    }
    const presented = parseBearer(req.headers.authorization);
    if (presented === null || !tokenMatches(presented, expectedToken)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send(errorBody('unauthorized', 'missing or invalid bearer token'));
    }
    return undefined; // authenticated: let the route run
  };
}
