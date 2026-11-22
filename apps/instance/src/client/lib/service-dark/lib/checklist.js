// Service Dark: what a Checklist's selection means, for the browser and the server alike.
//
// A selection is "all", "none", or a list of ids:
//   "all"       every item that can be checked, including items added later
//   "none"      no items, including items added later
//   ["a", "c"]  exactly these items, as checked one by one; items added later start unchecked
// "all" and "none" come only from the All checkbox and are stored as they are, never as today's ids.
// Checking or unchecking a single box turns the selection into a list of ids.
// Disabled items can't be selected, so "all" never includes them.

import { z } from "zod";

/** Validates a stored or submitted selection at every boundary. */
export const ChecklistSelection = z.union([z.literal("all"), z.literal("none"), z.array(z.string())]);

/**
 * Whether an item is selected.
 * @param {"all" | "none" | string[]} selection
 * @param {{ id: string, disabled?: boolean }} item
 */
export function isSelected(selection, item) {
  if (selection === "all") return !item.disabled;
  if (selection === "none") return false;
  return selection.includes(item.id);
}

/**
 * The ids a selection covers among these items, such as on the server just before acting on them.
 * @param {"all" | "none" | string[]} selection
 * @param {{ id: string, disabled?: boolean }[]} items
 */
export function selectedIds(selection, items) {
  return items.filter((item) => isSelected(selection, item)).map((item) => item.id);
}
