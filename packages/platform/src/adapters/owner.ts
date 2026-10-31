import { hashPassword } from "better-auth/crypto";
import { withTransaction } from "./database.js";
import { OWNER_ROLE } from "../runtime/auth.js";

// Makes the account with this email the app's only owner, sets its password, marks the email
// verified and deletes its sessions, in one transaction. Only someone holding the project's
// tokens can reach the database, so this needs no secret of its own. False when no account has
// that email.
export async function resetOwner(databaseUrl: string, email: string, password: string): Promise<boolean> {
  return withTransaction(databaseUrl, async (client) => {
    const { rows } = await client.query<{ id: string }>(`select id from "user" where email = $1`, [email.trim().toLowerCase()]);
    const id = rows[0]?.id;
    if (!id) return false;
    const hash = await hashPassword(password);
    await client.query(`update "user" set role = 'user', updated_at = now() where role = $1 and id <> $2`, [OWNER_ROLE, id]);
    await client.query(`update "user" set role = $1, email_verified = true, updated_at = now() where id = $2`, [OWNER_ROLE, id]);
    const updated = await client.query(`update account set password = $1, updated_at = now() where user_id = $2 and provider_id = 'credential'`, [hash, id]);
    if (updated.rowCount === 0) {
      await client.query(`insert into account (account_id, provider_id, user_id, password) values ($1, 'credential', $2, $3)`, [id, id, hash]);
    }
    await client.query(`delete from session where user_id = $1`, [id]);
    return true;
  });
}
