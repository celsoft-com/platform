import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
// Lets the declaration of createAuth name the OAuth provider types the MCP plugin brings.
import type {} from "@better-auth/oauth-provider";
// Lets the declaration of createAuth name the schema types the API key plugin brings.
import type {} from "@better-auth/core/db/internal";
import { admin, jwt } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { authSchema } from "../schema.js";
import type { Email } from "./email.js";

export const AUTH_PATH = "/api/auth";
export const TOKEN_DAYS = 90;
export const MAX_TOKEN_DAYS = 365;
export const TOKEN_PREFIX = "pat_";
export const OWNER_ROLE = "owner";

export interface AuthSettings {
  db: NodePgDatabase<Record<string, unknown>>;
  secret: string;
  baseURL: string;
  email: Email;
  requireVerification: boolean;
}

export function createAuth({ db, secret, baseURL, email, requireVerification }: AuthSettings) {
  return betterAuth({
    secret,
    baseURL,
    basePath: AUTH_PATH,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    // The JWT plugin's session-to-token route is not part of the platform.
    disabledPaths: ["/token"],
    // Postgres fills every id with uuidv7(), so Better Auth leaves the column out.
    advanced: { database: { generateId: "uuid" } },
    // The Workers rate limiting binding guards these routes before Better Auth sees them.
    rateLimit: { enabled: false },
    session: {
      // Most requests read the session from a signed cookie instead of the database; a revoked
      // session therefore keeps working until this copy expires.
      cookieCache: { enabled: true, maxAge: 60 },
    },
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
    databaseHooks: {
      user: {
        create: {
          // The first account becomes the owner; a single statement, so two at once cannot both win.
          after: async (user) => {
            await db.execute(sql`update "user" set role = ${OWNER_ROLE} where id = ${user.id} and not exists (select 1 from "user" where role = ${OWNER_ROLE})`);
          },
        },
      },
    },
    // Always installed so their tables and types never change; the runtime hides the MCP routes
    // unless platform.jsonc turns MCP on. Organizations are the platform's own, in organizations.ts.
    plugins: [
      admin({ defaultRole: "user", adminRoles: [OWNER_ROLE, "admin"], roles: { [OWNER_ROLE]: adminAc, admin: adminAc, user: userAc } }),
      // Personal API tokens: hashed, 90 days unless the creator picks another length up to 365, with
      // the cap in their metadata. The platform verifies them itself on /api/ and never lets Better
      // Auth turn one into a session, so no token reaches /api/auth/*.
      apiKey({
        defaultPrefix: TOKEN_PREFIX,
        requireName: true,
        maximumNameLength: 100,
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        // Read from no header, so Better Auth itself never accepts a token.
        apiKeyHeaders: [],
        keyExpiration: { defaultExpiresIn: TOKEN_DAYS * 24 * 60 * 60, minExpiresIn: 1, maxExpiresIn: MAX_TOKEN_DAYS },
        rateLimit: { enabled: false },
      }),
      // The OAuth server AI clients sign in through to reach the app's MCP endpoints; its tokens
      // are JWTs bound to the app's /mcp, signed with keys the JWT plugin keeps.
      // Without this, every session lookup signs a JWT into a set-auth-jwt header, reading the
      // signing keys from the database; nothing the platform serves reads that header.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: `${baseURL}/mcp`,
        scopes: ["openid", "profile", "email", "offline_access"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Clients that leave out their type are judged by their redirect URIs, so local ones work.
        clientRegistrationDefaultApplicationType: "infer",
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
