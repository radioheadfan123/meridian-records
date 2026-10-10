// The browser reaches the API through the Netlify proxy, so the TCP peer Railway sees is a
// Netlify server shared by every visitor, and Netlify puts its own address first in
// X-Forwarded-For. It passes the real client in X-Nf-Client-Connection-Ip. Rate limits and
// audit rows both key on this so they track people, not the proxy.
// ponytail: both headers are client-supplied for anyone calling Railway directly, so a
// direct caller can pick their own rate-limit bucket and logged IP. Account lockout is per
// account and unaffected. Restrict Railway to Netlify's egress if that ever matters.
function clientIp(req) {
  return (
    req.headers['x-nf-client-connection-ip']?.trim() ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

module.exports = { clientIp };
