import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyVisitor, visitorKey, visitSource } from './visitor.js';

const UA = {
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  mobileSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
};
const RESIDENTIAL_ASN = 7303;

test('classifyVisitor: real browsers, desktop and mobile', () => {
  for (const ua of Object.values(UA)) assert.equal(classifyVisitor({ ua, asn: RESIDENTIAL_ASN }), 'browser', ua);
  assert.equal(classifyVisitor({ ua: UA.mobileSafari }), 'browser');
});

test('classifyVisitor: bots, headless browsers, tools, link previews and empty UA', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
    'curl/8.5.0', 'Wget/1.21', 'python-requests/2.32', 'Go-http-client/2.0', 'Java/17.0.2', 'okhttp/4.12.0',
    'axios/1.7.2', 'node-fetch/1.0', 'facebookexternalhit/1.1', 'WhatsApp/2.23.20.0', 'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Chrome-Lighthouse)', 'Pingdom.com_bot_version_1.4', 'UptimeRobot/2.0', 'Yahoo Slurp',
  ];
  for (const ua of bots) assert.equal(classifyVisitor({ ua, asn: RESIDENTIAL_ASN }), 'bot', ua);
  assert.equal(classifyVisitor({ ua: '', asn: RESIDENTIAL_ASN }), 'bot');
  assert.equal(classifyVisitor({ ua: '   ' }), 'bot');
  assert.equal(classifyVisitor({}), 'bot');
});

test('classifyVisitor: mail/cloud scanners by ASN or UA; scanner wins over bot', () => {
  for (const asn of [15169, 396982, 8075, 22843, 26211, 30031, 15324, 16509, 14618, 14061, 16276, 24940]) {
    assert.equal(classifyVisitor({ ua: UA.chromeDesktop, asn }), 'scanner', String(asn));
  }
  const scannerUas = [
    'Proofpoint URL Defense', 'Mimecast-Link-Scanner', 'Barracuda Sentinel', 'Microsoft SafeLinks', 'urldefense.com',
    'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', 'Google-Safety',
  ];
  for (const ua of scannerUas) assert.equal(classifyVisitor({ ua, asn: RESIDENTIAL_ASN }), 'scanner', ua);
  assert.equal(classifyVisitor({ ua: 'curl/8.5.0', asn: 16509 }), 'scanner');
  assert.equal(classifyVisitor({ ua: '', asn: 8075 }), 'scanner');
});

test('visitSource: email only for e=1', () => {
  const source = (query) => visitSource(new URL(`https://demo.web-express.com.ar/${query}`));
  assert.equal(source('?e=1'), 'email');
  assert.equal(source('about/?x=2&e=1'), 'email');
  assert.equal(source(''), 'direct');
  assert.equal(source('?e=0'), 'direct');
  assert.equal(source('?e=11'), 'direct');
});

test('visitorKey: deterministic 32 hex, depends on salt/ip/ua, never contains the IP', async () => {
  const visitor = { salt: 'salt', ip: '203.0.113.7', ua: UA.chromeDesktop };
  const key = await visitorKey(visitor);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(await visitorKey({ ...visitor }), key);
  assert.notEqual(await visitorKey({ ...visitor, salt: 'other' }), key);
  assert.notEqual(await visitorKey({ ...visitor, ip: '203.0.113.8' }), key);
  assert.notEqual(await visitorKey({ ...visitor, ua: UA.firefox }), key);
  assert.ok(!key.includes(visitor.ip));
});
