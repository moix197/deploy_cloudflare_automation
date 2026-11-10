const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Demo no encontrada · Web Express</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 28rem; text-align: center; }
  .brand { font-weight: 700; letter-spacing: .04em; color: #38bdf8; }
  h1 { font-size: 1.5rem; margin: .75rem 0 .5rem; color: #f8fafc; }
  p { margin: 0 0 1.25rem; color: #94a3b8; }
  a { color: #38bdf8; }
</style>
</head>
<body>
<main>
  <div class="brand">Web Express</div>
  <h1>Demo no encontrada</h1>
  <p>Esta demo no existe o ya no está disponible.</p>
  <a href="https://__BASE__/">Ir a __BASE__</a>
</main>
</body>
</html>
`;

/** Branded 404 for a host under the demo domain that has no placed demo. */
export function demoNotFound(request, baseDomain) {
  const body = request.method === 'HEAD' ? null : PAGE.replaceAll('__BASE__', baseDomain);
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
