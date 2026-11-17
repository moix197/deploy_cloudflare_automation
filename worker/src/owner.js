import { sha256Hex, timingSafeEqualText } from './hash.js';

const OWNER_PATH = '/__wx-owner';
const COOKIE_NAME = 'wx_owner';
// 400 days, the longest lifetime browsers honor.
const COOKIE_MAX_AGE_S = 34560000;
const PAGE = '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Owner mode on</title><p>Owner mode on</p>';

function ownerToken(secret) {
  return sha256Hex(`wx-owner:${secret}`);
}

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function ownerCookie(token, baseDomain) {
  return `${COOKIE_NAME}=${token}; Domain=.${baseDomain}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * `/__wx-owner?k=<OWNER_LINK_SECRET>` → "Owner mode on" page that sets the owner
 * cookie on every demo host. Anything else (wrong/missing key or secret) → null,
 * so the request continues as a normal one and gives no hint.
 */
export async function ownerLinkResponse(url, env) {
  const key = url.searchParams.get('k');
  if (url.pathname !== OWNER_PATH || !key || !env.OWNER_LINK_SECRET) return null;
  if (!(await timingSafeEqualText(key, env.OWNER_LINK_SECRET))) return null;
  return new Response(PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': ownerCookie(await ownerToken(env.OWNER_LINK_SECRET), env.DEMO_BASE_DOMAIN),
    },
  });
}

export async function isOwnerRequest(request, secret) {
  const cookie = cookieValue(request.headers.get('Cookie'), COOKIE_NAME);
  if (!cookie || !secret) return false;
  return timingSafeEqualText(cookie, await ownerToken(secret));
}
