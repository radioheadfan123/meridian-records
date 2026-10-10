// The browser reaches the API through the Netlify proxy, so the TCP peer Railway sees is a
// Netlify server, shared by every visitor. The real client is the first X-Forwarded-For
// entry. Rate limits and audit rows both key on this so they track people, not the proxy.
// ponytail: X-Forwarded-For is client-supplied for anyone calling Railway directly, so a
// direct caller can pick their own rate-limit bucket. Account lockout is per account and
// unaffected. Restrict Railway to Netlify's egress if that ever matters.
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || 'unknown';
}

module.exports = { clientIp };
