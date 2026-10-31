import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { EndpointError } from "./endpoint-error.js";

// Primitives the runtime modules share.

export type Db = NodePgDatabase<Record<string, unknown>>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const notFound = () => new EndpointError(404, "not found");
export const conflict = (message: string) => new EndpointError(409, message);

export const rows = async <T>(db: Pick<Db, "execute">, query: SQL): Promise<T[]> => (await db.execute(query)).rows as T[];

// A request's JSON body, or undefined when it has none or it is not JSON; `clone` leaves the
// request readable by whoever answers it next.
export async function readJsonBody<T = Record<string, unknown>>(request: Request, { clone = false } = {}): Promise<T | undefined> {
  return (await (clone ? request.clone() : request).json().catch(() => undefined)) as T | undefined;
}
