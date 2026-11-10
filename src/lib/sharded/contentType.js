import { extname } from 'node:path';

// The subset of mime@3 (the table wrangler bundles for `pages deploy`) that
// static demo sites use; contentType.test.js checks every entry against
// wrangler's bundled table. Unlisted extensions fall back the way wrangler
// does for an unknown type.
const CONTENT_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  ics: 'text/calendar',
  pdf: 'application/pdf',
  zip: 'application/zip',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/vnd.microsoft.icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

export const KNOWN_EXTENSIONS = Object.keys(CONTENT_TYPES);

export function contentTypeFor(name) {
  return CONTENT_TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}
