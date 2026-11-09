import { createNeonAuth } from "@neon/auth/next/server";

let instance: ReturnType<typeof createNeonAuth> | undefined;

export function getAuth(): ReturnType<typeof createNeonAuth> {
  if (instance) return instance;
  const baseUrl = process.env.NEON_AUTH_BASE_URL;
  const secret = process.env.NEON_AUTH_COOKIE_SECRET;
  if (!baseUrl || !secret || secret.length < 32) throw new Error("Owner authentication is not configured");
  instance = createNeonAuth({ baseUrl, cookies: { secret, sessionDataTtl: 1 } });
  return instance;
}

export async function ownerSession() {
  const { data } = await getAuth().getSession();
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email || !data?.user?.emailVerified || data.user.email.toLowerCase() !== email) return null;
  return { userId: data.user.id };
}
