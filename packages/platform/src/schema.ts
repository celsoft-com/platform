import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Better Auth's tables, with its core, admin and organization fields, transcribed from
// getAuthTables() in the installed version; schema.test.ts fails when they drift apart.
// Property keys stay camelCase because the Drizzle adapter matches Better Auth's field names
// against them; column names are snake_case like the rest of an app's tables.

// Every id is a UUIDv7 filled by Postgres 18, so ids sort by creation time and are never
// supplied by code. An id is not a secret: anything unguessable gets its own token.
export const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const user = pgTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  ...timestamps(),
});

export const session = pgTable(
  "session",
  {
    id: id(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: uuid("impersonated_by"),
    activeOrganizationId: uuid("active_organization_id"),
    activeTeamId: uuid("active_team_id"),
    ...timestamps(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Organization tables exist whenever auth is on, so turning organizations off and on again
// only hides and restores routes; no migration ever drops their data.
export const organization = pgTable("organization", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  ...timestamps(),
});

export const member = pgTable(
  "member",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    ...timestamps(),
  },
  (t) => [index("member_organization_id_idx").on(t.organizationId), index("member_user_id_idx").on(t.userId)],
);

export const invitation = pgTable(
  "invitation",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    teamId: uuid("team_id"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [index("invitation_organization_id_idx").on(t.organizationId), index("invitation_email_idx").on(t.email)],
);

export const team = pgTable(
  "team",
  {
    id: id(),
    name: text("name").notNull(),
    memberCount: integer("member_count").notNull().default(0),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [index("team_organization_id_idx").on(t.organizationId)],
);

export const teamMember = pgTable(
  "team_member",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").unique(),
    ...timestamps(),
  },
  (t) => [index("team_member_team_id_idx").on(t.teamId), index("team_member_user_id_idx").on(t.userId)],
);

// The JWT and MCP plugins: signing keys, and the OAuth clients, tokens and consents of AI clients
// that sign in to an app's MCP server. Installed for every app with auth, used when MCP is on.

const at = (name: string) => timestamp(name, { withTimezone: true });
const texts = (name: string) => text(name).array();

export const jwks = pgTable("jwks", {
  id: id(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
  expiresAt: at("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: id(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: texts("scopes"),
    clientCredentialsScopes: texts("client_credentials_scopes"),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: at("created_at").defaultNow(),
    updatedAt: at("updated_at").defaultNow(),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: texts("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: texts("redirect_uris").notNull(),
    postLogoutRedirectUris: texts("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: texts("grant_types"),
    responseTypes: texts("response_types"),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_client_user_id_idx").on(t.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
  id: id(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: texts("allowed_scopes"),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: at("created_at").defaultNow(),
  updatedAt: at("updated_at").defaultNow(),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: at("created_at").defaultNow(),
  },
  (t) => [index("oauth_client_resource_client_id_idx").on(t.clientId), index("oauth_client_resource_resource_id_idx").on(t.resourceId)],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: id(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: texts("resources"),
    requestedUserInfoClaims: texts("requested_user_info_claims"),
    expiresAt: at("expires_at"),
    createdAt: at("created_at").defaultNow(),
    revoked: at("revoked"),
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authTime: at("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: texts("scopes").notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_id_idx").on(t.clientId),
    index("oauth_refresh_token_session_id_idx").on(t.sessionId),
    index("oauth_refresh_token_user_id_idx").on(t.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: id(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: texts("resources"),
    requestedUserInfoClaims: texts("requested_user_info_claims"),
    refreshId: uuid("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: at("expires_at"),
    createdAt: at("created_at").defaultNow(),
    revoked: at("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: texts("scopes").notNull(),
  },
  (t) => [
    index("oauth_access_token_client_id_idx").on(t.clientId),
    index("oauth_access_token_session_id_idx").on(t.sessionId),
    index("oauth_access_token_user_id_idx").on(t.userId),
    index("oauth_access_token_authorization_code_id_idx").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_id_idx").on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: texts("resources"),
    requestedUserInfoClaims: texts("requested_user_info_claims"),
    scopes: texts("scopes").notNull(),
    createdAt: at("created_at").defaultNow(),
    updatedAt: at("updated_at").defaultNow(),
  },
  (t) => [index("oauth_consent_client_id_idx").on(t.clientId), index("oauth_consent_user_id_idx").on(t.userId)],
);

// Its id is a client assertion's jti, chosen by the client, so it is text rather than a UUID.
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
});

export const authSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  team,
  teamMember,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
};
