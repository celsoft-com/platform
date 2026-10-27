import { id, organization, timestamps, user } from "@celsoft/platform/schema";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const notes = pgTable(
  "notes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Set for an organization's note, whose control point inherits from the organization's; empty for a personal note.
    organizationId: uuid("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    attachmentName: text("attachment_name"),
    attachmentType: text("attachment_type"),
    ...timestamps(),
  },
  (t) => [
    index("notes_user_created_idx").on(t.userId, t.createdAt),
    index("notes_organization_created_idx").on(t.organizationId, t.createdAt),
    check("notes_body_length", sql`length(${t.body}) between 1 and 10000`),
  ],
);
