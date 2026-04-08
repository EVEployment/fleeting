/**
 * server/lib/auth.ts
 *
 * OIDC (in-house) auth flow + session helpers.
 *
 * In-house OIDC JWT claims (id_token / access_token):
 *   sub, uid (character ID as string), nam (character name),
 *   acct ([{id, name, valid}] — all characters on the account),
 *   scp, groups, exp
 *
 * EVE character token flow:
 *   Instead of an EVE-level refresh_token, we call:
 *     POST <issuer>/oauth/passthrough/<character_id>
 *   with the in-house OIDC access_token as Bearer auth.
 *   This returns a short-lived EVE SSO access_token (no refresh_token).
 *   The returned JWT is validated against login.eveonline.com JWKS.
 */

import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/pg.js';
import { verifyJwt, getOidcJwksUrl, getEveSsoJwksUrl } from './jwks.js';

const OIDC_ISSUER    = process.env.OIDC_ISSUER!;
const CLIENT_ID      = process.env.OIDC_CLIENT_ID!;
const CLIENT_SECRET  = process.env.OIDC_CLIENT_SECRET!;
const REDIRECT_URI   = process.env.OIDC_REDIRECT_URI!;

// ── Shared discovery cache ─────────────────────────────────────────────────────

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

let discoveryCache: { data: OidcDiscovery; at: number } | null = null;

async function getDiscovery(): Promise<OidcDiscovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < 5 * 60 * 1000) {
    return discoveryCache.data;
  }
  const data = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`).then(
    (r) => r.json() as Promise<OidcDiscovery>,
  );
  discoveryCache = { data, at: Date.now() };
  return data;
}

// ── Session-stored OIDC token helpers ─────────────────────────────────────────

/**
 * Ensure the in-house OIDC access_token in the session is still valid.
 * If it's within 60 s of expiry, refresh it using the stored refresh_token,
 * decode the new id_token / access_token to get updated `acct` list, and
 * sync `eve_characters` in the DB.
 */
async function ensureOidcToken(session: FastifyRequest['session']): Promise<string> {
  const now = Date.now();

  if (session.oidcAccessToken && (!session.oidcAccessExpiry || session.oidcAccessExpiry - now > 60_000)) {
    return session.oidcAccessToken;
  }

  if (!session.oidcRefreshToken) {
    throw new Error('No OIDC refresh_token in session — user must re-authenticate');
  }

  const discovery = await getDiscovery();

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: session.oidcRefreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`OIDC token refresh failed: ${tokenRes.status}`);
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  // Validate and decode the refreshed token (use id_token if present, else access_token)
  const jwtToVerify = tokens.id_token ?? tokens.access_token;
  const jwksUrl = await getOidcJwksUrl();
  const claims = await verifyJwt(jwtToVerify, jwksUrl, { issuer: OIDC_ISSUER }) as Record<string, unknown>;

  // Update session
  session.oidcAccessToken  = tokens.access_token;
  session.oidcAccessExpiry = Date.now() + tokens.expires_in * 1000;
  if (tokens.refresh_token) session.oidcRefreshToken = tokens.refresh_token;

  // Sync eve_characters from the updated `acct` claim
  if (Array.isArray(claims.acct) && session.userId) {
    await syncCharactersFromAcct(session.userId, claims.acct as AccountInfo[]);
    session.characters = (claims.acct as AccountInfo[])
      .filter((c) => c.valid)
      .map((c) => ({ id: c.id, name: c.name }));
  }

  return tokens.access_token;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface AccountInfo {
  id:    number;
  name:  string;
  valid: boolean;
}

// ── Character sync ─────────────────────────────────────────────────────────────

async function syncCharactersFromAcct(userId: string, acct: AccountInfo[]): Promise<void> {
  for (const char of acct) {
    if (!char.valid) continue;
    await query(
      `INSERT INTO eve_characters (id, user_id, character_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET character_name = EXCLUDED.character_name`,
      [char.id, userId, char.name],
    );
  }
}

// ── OIDC login / callback ──────────────────────────────────────────────────────

export async function oidcLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const state         = crypto.randomBytes(16).toString('hex');
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  req.session.oidcState        = state;
  req.session.oidcCodeVerifier = codeVerifier;

  const discovery = await getDiscovery();

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type',          'code');
  url.searchParams.set('client_id',              CLIENT_ID);
  url.searchParams.set('redirect_uri',           REDIRECT_URI);
  url.searchParams.set('scope',                  'openid accounts groups passthrough esi-fleets.read_fleet.v1 esi-fleets.write_fleet.v1 esi-location.read_online.v1');
  url.searchParams.set('state',                  state);
  url.searchParams.set('code_challenge',         codeChallenge);
  url.searchParams.set('code_challenge_method',  'S256');

  // Save session explicitly before redirecting so @fastify/session's onSend
  // hook sees no pending changes and skips its async pg save — preventing the
  // ERR_HTTP_HEADERS_SENT crash caused by connect-pg-simple's callback firing
  // after the response has already been sent.
  await req.session.save();
  return reply.redirect(url.toString()) as unknown as void;
}

export async function oidcCallback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { code, state } = req.query as Record<string, string>;

  if (!code || state !== req.session.oidcState) {
    return reply.code(400).send({ error: 'Invalid state' }) as unknown as void;
  }

  const codeVerifier = req.session.oidcCodeVerifier ?? '';
  delete req.session.oidcState;
  delete req.session.oidcCodeVerifier;

  const discovery = await getDiscovery();

  const tokenRes = await fetch(discovery.token_endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    return reply.code(502).send({ error: 'Token exchange failed' }) as unknown as void;
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  // Verify id_token (or access_token) against in-house OIDC JWKS
  const jwtToVerify = tokens.id_token ?? tokens.access_token;
  const jwksUrl = await getOidcJwksUrl();
  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(jwtToVerify, jwksUrl, { issuer: OIDC_ISSUER }) as Record<string, unknown>;
  } catch (err) {
    console.error('[auth] JWT verification failed:', err);
    return reply.code(401).send({ error: 'JWT verification failed' }) as unknown as void;
  }

  // In-house OIDC claims: uid = character ID string, nam = name,
  // acct = [{id, name, valid}], groups = Set of group names
  const oidcSub  = (claims.sub  ?? claims.uid) as string;
  const name     = (claims.nam  ?? claims.name) as string ?? 'Unknown';
  const acct     = (claims.acct ?? []) as AccountInfo[];
  const groups   = (claims.groups ?? []) as string[];
  const roles    = mapGroupsToRoles(groups);

  // Upsert user
  const { rows } = await query(
    `INSERT INTO users (oidc_sub, name, roles)
     VALUES ($1, $2, $3)
     ON CONFLICT (oidc_sub) DO UPDATE
       SET name = EXCLUDED.name, roles = EXCLUDED.roles, updated_at = NOW()
     RETURNING id`,
    [oidcSub, name, roles],
  );
  const userId: string = rows[0].id;

  // Sync eve_characters from acct claim
  await syncCharactersFromAcct(userId, acct);

  // Regenerate session ID to prevent session-fixation attacks.
  // @fastify/session v10 preserves the session store entry but issues a new cookie.
  await req.session.regenerate();

  // Store OIDC tokens in the fresh session
  req.session.userId           = userId;
  req.session.roles            = roles;
  req.session.characters       = acct.filter((c) => c.valid).map((c) => ({ id: c.id, name: c.name }));
  req.session.oidcAccessToken  = tokens.access_token;
  req.session.oidcAccessExpiry = Date.now() + tokens.expires_in * 1000;
  if (tokens.refresh_token) req.session.oidcRefreshToken = tokens.refresh_token;

  return reply.redirect('/pilot') as unknown as void;
}

// ── Role mapping ───────────────────────────────────────────────────────────────

/**
 * Map in-house OIDC `groups` claim values to application roles.
 * Extend this list to match your OIDC provider's group names.
 */
function mapGroupsToRoles(groups: string[]): string[] {
  const roleSet = new Set<string>();
  for (const group of groups) {
    const lower = group.toLowerCase();
    if (lower === 'ticker-member') {
      roleSet.add('pilot');
    }
    if (['fc', 't2-fc', '[auto] t2-fc', 'junior-fc', 'exec', 'it'].includes(lower)) {
      roleSet.add('fc');
    }
    if (['exec', 'it'].includes(lower)) {
      roleSet.add('war_commander');
    }
  }
  // Every authenticated user is at least a pilot
  // roleSet.add('pilot');
  return [...roleSet];
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.session.userId) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

export function requireRole(role: string) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.session.userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    if (!req.session.roles?.includes(role)) {
      reply.code(403).send({ error: 'Forbidden' });
    }
  };
}

// ── EVE passthrough token ──────────────────────────────────────────────────────

/**
 * Obtains (or returns a cached) EVE SSO access_token for the given character
 * by calling the in-house OIDC passthrough endpoint:
 *   POST <OIDC_ISSUER>/oauth/passthrough/<character_id>
 *
 * The returned JWT is validated against login.eveonline.com's JWKS.
 * No refresh_token is stored — the token is re-fetched via passthrough when it expires.
 */
export async function exchangeEveToken(
  characterId: number,
  session: FastifyRequest['session'],
): Promise<string> {
  // Check cached EVE token in DB
  const { rows } = await query(
    'SELECT access_token, token_expires_at FROM eve_characters WHERE id = $1',
    [characterId],
  );
  if (!rows.length) throw new Error(`Character ${characterId} not found`);

  const char = rows[0] as { access_token: string | null; token_expires_at: Date | null };
  const expiry = char.token_expires_at ? char.token_expires_at.getTime() : 0;

  if (char.access_token && expiry - Date.now() > 60_000) {
    return char.access_token;
  }

  // Obtain a fresh in-house OIDC access_token (refresh if expired)
  const oidcToken = await ensureOidcToken(session);

  // Call the passthrough endpoint
  const passthroughUrl = `${OIDC_ISSUER}/oauth/passthrough/${characterId}`;
  const passRes = await fetch(passthroughUrl, {
    method:  'POST',
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // Passthrough accepts optional scope restriction; we request ESI scopes
    body: new URLSearchParams({ scope: 'esi-fleets.read_fleet.v1 esi-fleets.write_fleet.v1' }),
  });

  if (!passRes.ok) {
    const detail = await passRes.text().catch(() => '');
    console.error(`[auth] Passthrough failed ${passRes.status} for char ${characterId}:`, detail);
    throw new Error(`Passthrough failed with status ${passRes.status}`);
  }

  const passTokens = await passRes.json() as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  const eveAccessToken = passTokens.access_token;

  // Validate against EVE SSO JWKS
  const eveSsoJwksUrl = await getEveSsoJwksUrl();
  try {
    const eveClaims = await verifyJwt(eveAccessToken, eveSsoJwksUrl, {
      issuer: 'https://login.eveonline.com',
    }) as {
      sub?: string;
      name?: string;
      exp?: number;
    };
    // EVE SSO sub format: "CHARACTER:EVE:<id>"
    const subCharId = eveClaims.sub?.split(':').at(-1);
    if (subCharId && Number(subCharId) !== characterId) {
      throw new Error('Passthrough token subject mismatch');
    }
  } catch (err) {
    throw new Error(`EVE SSO JWT verification failed: ${(err as Error).message}`);
  }

  // Cache the token
  const newExpiry = new Date(Date.now() + passTokens.expires_in * 1000);
  await query(
    `UPDATE eve_characters SET access_token = $1, token_expires_at = $2 WHERE id = $3`,
    [eveAccessToken, newExpiry, characterId],
  );

  return eveAccessToken;
}
