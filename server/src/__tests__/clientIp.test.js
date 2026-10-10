const { clientIp } = require('../lib/clientIp');

const req = (headers, remoteAddress = '10.0.0.1') => ({ headers, socket: { remoteAddress } });

test("Netlify's client header wins over X-Forwarded-For, whose first hop is Netlify itself", () => {
  expect(clientIp(req({ 'x-nf-client-connection-ip': '47.1.2.3', 'x-forwarded-for': '98.90.93.124, 10.1.1.1' }))).toBe('47.1.2.3');
});

test('direct calls fall back to the first X-Forwarded-For hop, then the socket', () => {
  expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.1.1.1' }))).toBe('203.0.113.9');
  expect(clientIp(req({}))).toBe('10.0.0.1');
});
