import { betterAuth, type BetterAuthOptions } from "better-auth";
import { PostgresJSDialect } from "kysely-postgres-js";
import type postgres from "postgres";
import type { Email } from "./email.js";

export const AUTH_PATH = "/api/auth";

export interface AuthSettings {
  sql: postgres.Sql;
  secret: string;
  baseURL: string;
  email: Email;
  requireVerification: boolean;
}

// Shared by the Worker and by `platform deploy`, which creates the auth tables from it.
export function authOptions({ sql, secret, baseURL, email, requireVerification }: AuthSettings): BetterAuthOptions {
  return {
    secret,
    baseURL,
    basePath: AUTH_PATH,
    database: { dialect: new PostgresJSDialect({ postgres: sql }), type: "postgres" },
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
