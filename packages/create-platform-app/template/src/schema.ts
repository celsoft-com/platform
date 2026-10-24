import { id, timestamps } from "@celsoft/platform/schema";
import { pgTable, text } from "drizzle-orm/pg-core";

// The app's tables. After changing them, run `npx @celsoft/platform db generate` and commit drizzle/.
export const items = pgTable("items", {
  id: id(),
  name: text("name").notNull(),
  ...timestamps(),
});
