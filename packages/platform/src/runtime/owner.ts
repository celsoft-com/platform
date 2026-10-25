import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ownerRecovery, user } from "../schema.js";
import { OWNER_ROLE, type Auth } from "./auth.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// Five groups of five from 31 characters: about 124 bits, so a plain hash is enough to store it.
export function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{5}/g)!.join("-");
}

export async function hashCode(code: string): Promise<string> {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Db = NodePgDatabase<Record<string, unknown>>;

// Shown once, right after the owner signs in without one; the screen tells them to save it.
// The role is read from the database: the session's cached copy predates the owner claim.
export async function issueRecoveryCode(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  if (row?.role !== OWNER_ROLE) return null;
  const code = newRecoveryCode();
  const inserted = await db
    .insert(ownerRecovery)
    .values({ userId, codeHash: await hashCode(code) })
    .onConflictDoNothing()
    .returning({ userId: ownerRecovery.userId });
  return inserted.length > 0 ? code : null;
}

// Sets a new password for the owner and signs every session out. The answer never says which
// part was wrong, so it reveals nothing about who the owner is.
export async function recoverOwner(db: Db, auth: Auth, input: { email: string; code: string; password: string }): Promise<boolean> {
  const [owner] = await db
    .select({ id: user.id, codeHash: ownerRecovery.codeHash })
    .from(user)
    .innerJoin(ownerRecovery, eq(ownerRecovery.userId, user.id))
    .where(and(eq(user.email, input.email.trim().toLowerCase()), eq(user.role, OWNER_ROLE)));
  if (!owner || !equal(owner.codeHash, await hashCode(input.code))) return false;

  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(owner.id, await ctx.password.hash(input.password));
  await ctx.internalAdapter.deleteUserSessions(owner.id);
  await db.delete(ownerRecovery).where(eq(ownerRecovery.userId, owner.id));
  return true;
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
