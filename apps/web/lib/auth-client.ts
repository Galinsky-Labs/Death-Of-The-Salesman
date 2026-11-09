"use client";

import { createAuthClient } from "@neon/auth/next";

export const authClient: ReturnType<typeof createAuthClient> = createAuthClient();
