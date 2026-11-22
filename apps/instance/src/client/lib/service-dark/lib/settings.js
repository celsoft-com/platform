// Service Dark: turns a Zod settings schema into the model the Settings page renders.
//
// The schema is a z.object of categories, each a z.object of settings:
//   z.object({ runtime: z.object({ region: z.enum([...]).default("us-west-2").meta({ title: "Region" }) }).meta({ title: "Runtime", icon: "cpu" }) })
// A setting may hold anything Zod can describe, such as a list of objects; a category whose settings need
// their own layout is drawn by the app as a custom page (Settings' pages prop) and saved the same way.
//
// Metadata read from .meta():
//   category: title, description, icon (Lucide name)
//   category: save ("button": its changes wait for a Save; a category holding a secret always does)
//   setting:  title, description, unit, mono, placeholder, readOnly, labels (enum value -> label), secret (a string shown in a masked TokenField),
//             wait (a boolean whose switch flips only once the save succeeds)
// Everything else (type, enum options, min, max, defaults) comes from the schema itself,
// read through z.toJSONSchema, so the page never depends on Zod internals.

import { z } from "zod";

/**
 * @typedef {object} SettingField
 * @property {string} id "category.key"
 * @property {string} category
 * @property {string} key
 * @property {string} title
 * @property {string} [description]
 * @property {unknown} default
 * @property {boolean} readOnly
 * @property {boolean} wait boolean only: flip once saved, for settings with real consequences
 * @property {boolean} mono
 * @property {string} [unit]
 * @property {string} [placeholder]
 * @property {"boolean" | "enum" | "number" | "list" | "text" | "secret" | "complex"} kind complex: objects or lists of objects, for custom pages
 * @property {{ value: string, label: string }[]} [options] enum only
 * @property {number} [min] number only
 * @property {number} [max] number only
 * @property {number | "any"} [step] number only
 */

/**
 * @typedef {object} SettingCategory
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string} [icon]
 * @property {boolean} saveButton true when its changes wait for a Save
 * @property {SettingField[]} settings
 */

/** @param {string} id */
const humanize = (id) => id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** @param {string} category @param {string} key @param {any} s @returns {SettingField} */
function describeSetting(category, key, s) {
  const base = {
    id: `${category}.${key}`,
    category,
    key,
    title: s.title ?? humanize(key),
    description: s.description,
    default: s.default,
    readOnly: s.readOnly === true,
    wait: s.wait === true,
    mono: s.mono === true,
    unit: s.unit,
    placeholder: s.placeholder
  };
  if (s.secret === true && s.type === "string") return { ...base, kind: "secret" };
  if (s.type === "boolean") return { ...base, kind: "boolean" };
  if (Array.isArray(s.enum)) return { ...base, kind: "enum", options: s.enum.map((v) => ({ value: v, label: s.labels?.[v] ?? String(v) })) };
  if (s.type === "number" || s.type === "integer") return { ...base, kind: "number", min: s.minimum, max: s.maximum, step: s.type === "integer" ? 1 : "any" };
  if (s.type === "array") return { ...base, kind: s.items?.type === "object" || s.items?.type === "array" ? "complex" : "list" };
  if (s.type === "object") return { ...base, kind: "complex" };
  return { ...base, kind: "text" };
}

/** Categories with their settings, in schema order. @param {import("zod").ZodObject} schema @returns {SettingCategory[]} */
export function describeSettings(schema) {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return Object.entries(/** @type {Record<string, any>} */ (json.properties ?? {})).map(([id, cat]) => {
    const settings = Object.entries(/** @type {any} */ (cat).properties ?? {}).map(([key, s]) => describeSetting(id, key, s));
    return {
      id,
      title: cat.title ?? humanize(id),
      description: cat.description,
      icon: cat.icon,
      saveButton: cat.save === "button" || settings.some((s) => s.kind === "secret"),
      settings
    };
  });
}

/** The Zod schema for one setting, used to validate a single change. @param {any} schema @param {string} category @param {string} key @returns {import("zod").ZodType} */
export function settingSchema(schema, category, key) {
  return schema.shape[category].shape[key];
}


/** True when the value differs from the setting's default. @param {SettingField} setting @param {unknown} value */
export function isModified(setting, value) {
  return value !== undefined && JSON.stringify(value) !== JSON.stringify(setting.default);
}
