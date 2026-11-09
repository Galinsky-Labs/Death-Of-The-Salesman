export function hasTrustedOrigin(request: Request): boolean {
  // Render terminates TLS before forwarding to Next. Request.url can therefore
  // carry HTTP even though the browser correctly sends our public HTTPS origin.
  // An explicit deployment origin avoids trusting client-supplied forwarded headers.
  const configured = process.env.APP_ORIGIN;
  if (process.env.APP_ENV === "production" && !configured) return false;
  try {
    const origin = new URL(configured ?? request.url).origin;
    return request.headers.get("origin") === origin;
  } catch { return false; }
}
