const encoder = new TextEncoder();

export async function authenticate(request, env) {
  const user = env.BASIC_AUTH_USER;
  const password = env.BASIC_AUTH_PASSWORD;
  if (typeof user !== 'string' || !user || user.includes(':') || typeof password !== 'string' || !password) {
    return new Response('Authentication is not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const match = request.headers.get('Authorization')?.match(/^Basic +([A-Za-z0-9+/]+={0,2})$/i);
  let credentials;
  try {
    if (match) credentials = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
  } catch {}
  if (credentials) {
    const [expected, actual] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(`${user}:${password}`)),
      crypto.subtle.digest('SHA-256', credentials)
    ]);
    // Workers' native comparison requires equal-size buffers.
    if (crypto.subtle.timingSafeEqual(expected, actual)) return null;
  }
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Pondro", charset="UTF-8"', 'Cache-Control': 'no-store' }
  });
}
