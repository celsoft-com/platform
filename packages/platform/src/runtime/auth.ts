import { betterAuth, type BetterAuthOptions } from "better-auth";
import { Pool } from "pg";
import type { Email } from "./email.js";

export const AUTH_PATH = "/api/auth";

export interface AuthSettings {
  pool: Pool;
  secret: string;
  baseURL: string;
  email: Email;
  requireVerification: boolean;
}

// Better Auth gets its own pg pool: sharing the app's postgres.js client through a Kysely
// dialect stalls on Workers, while pg is the driver Cloudflare documents for Hyperdrive.
export function authPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 1 });
}

// Shared by the Worker and by `platform deploy`, which creates the auth tables from it.
export function authOptions({ pool, secret, baseURL, email, requireVerification }: AuthSettings): BetterAuthOptions {
  return {
    secret,
    baseURL,
    basePath: AUTH_PATH,
    database: pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: requireVerification,
      sendResetPassword: async ({ user, url }) => {
        await email.send({ to: user.email, subject: "Reset your password", text: `Reset your password:\n\n${url}\n\nIf you did not ask for this, ignore this email.` });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await email.send({ to: user.email, subject: "Confirm your email", text: `Confirm your email address:\n\n${url}` });
      },
    },
  };
}

export function createAuth(settings: AuthSettings) {
  return betterAuth(authOptions(settings));
}

export type Auth = ReturnType<typeof createAuth>;
