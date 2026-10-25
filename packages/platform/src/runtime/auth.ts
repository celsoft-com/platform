import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp } from "@better-auth/mcp";
// Lets the declaration of createAuth name the OAuth provider types the MCP plugin brings.
import type {} from "@better-auth/oauth-provider";
import { admin, jwt, organization } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { authSchema } from "../schema.js";
import type { Email } from "./email.js";

export const AUTH_PATH = "/api/auth";
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
      cookieCache: { enabled: true, maxAge: 5 * 60 },
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
    // Always installed so their tables and types never change; the runtime hides their routes
    // unless platform.jsonc turns organizations or MCP on.
    plugins: [
      admin({ defaultRole: "user", adminRoles: [OWNER_ROLE, "admin"], roles: { [OWNER_ROLE]: adminAc, admin: adminAc, user: userAc } }),
      organization({
        teams: { enabled: true },
        sendInvitationEmail: async ({ email: to, organization: org, inviter, id }) => {
          await email.send({
            to,
            subject: `Join ${org.name}`,
            text: `${inviter.user.name} invited you to join ${org.name}:\n\n${baseURL}/login?invitation=${id}`,
          });
        },
      }),
      // The OAuth server AI clients sign in through to reach the app's MCP endpoints; its tokens
      // are JWTs bound to the app's /mcp, signed with keys the JWT plugin keeps.
      jwt(),
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
