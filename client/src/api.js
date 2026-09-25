const BASE = import.meta.env.VITE_API_URL || '';

export async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// File downloads can't go through a plain <a href>: the JWT lives in a header, not a
// cookie. Fetch with the header, then hand the browser the blob.
export async function download(path, { token, filename }) {
  const res = await fetch(`${BASE}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Download failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
