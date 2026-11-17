import { sha256Hex } from './hash.js';

// Best-effort noise filtering: mail link scanners and cloud hosts that pre-fetch
// links in emails. A real visitor on one of these networks is misclassified as
// a scanner, which only makes the dashboard undercount.
const SCANNER_ASNS = new Set([
  15169, 396982, // Google
  8075, // Microsoft
  22843, 26211, // Proofpoint
  30031, // Mimecast
  15324, // Barracuda
  16509, 14618, // AWS
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
]);
const SCANNER_UA = /proofpoint|mimecast|barracuda|safelinks|urldefense|googleimageproxy|google-safety/i;
const BOT_UA = /bot|crawl|spider|slurp|headless|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|facebookexternalhit|whatsapp|telegrambot|preview|lighthouse|pingdom|uptime/i;
const VISITOR_KEY_LENGTH = 32;

/** 'scanner' | 'bot' | 'browser'; scanner wins over bot. */
export function classifyVisitor({ ua = '', asn = null } = {}) {
  if (SCANNER_ASNS.has(Number(asn)) || SCANNER_UA.test(ua)) return 'scanner';
  if (!ua.trim() || BOT_UA.test(ua)) return 'bot';
  return 'browser';
}

/** Cold-email demo links carry `?e=1`. */
export function visitSource(url) {
  return url.searchParams.get('e') === '1' ? 'email' : 'direct';
}

/** Salted, truncated hash of ip+UA: groups one visitor's requests without storing the IP. */
export async function visitorKey({ salt, ip = '', ua = '' }) {
  return (await sha256Hex(`${salt}|${ip}|${ua}`)).slice(0, VISITOR_KEY_LENGTH);
}
