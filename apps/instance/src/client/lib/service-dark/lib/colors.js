// Service Dark: colors beyond the status set, for chips and tags, labels, projects, avatars, chart series,
// and any place people choose a color. There is no fixed list: a color is either
//
//   provided  a hex color, such as one a person chose: <Badge color="#7c3aed">
//   seeded    a string or number: <Badge seed="billing">, the same color for the same seed everywhere
//
// Either way it is fitted to the palette before use: its hue is kept, while its lightness and chroma are
// moved into the range the status colors use for each theme, so text in it reads at 4.5:1 on bg-200 and
// on its own tinted ground, in both themes. A person's dark navy and pale sky stay apart, since their
// relative lightness is kept within that range.
//
// Seeds: numbers 1, 2, 3... walk a fixed sequence that keeps each new color as far as possible from the ones
// before it; use the item's position for a list that should look distinct. A string is hashed, so any text maps to a color.
// Past about a dozen on one screen some colors will look alike; the label still tells them apart.
//
// Store a provided color as its hex and validate it with UserColor. Store nothing for a seeded color:
// the seed is the data you already have.

import { z } from "zod";

/** A color a person chose or the app picked, as stored: #rrggbb. */
export const UserColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a color.");

// ---- OKLab math (Björn Ottosson) -----------------------------------------------------------

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToLinear = (hex) => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

function hexToOklch(hex) {
  const [r, g, b] = hexToLinear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255).toString(16).padStart(2, "0")).join("");
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);

// ---- Fitting to the palette ------------------------------------------------------------------

/**
 * Where colors may sit in each theme, from the status colors' lightness and chroma, and the bg-200 they
 * must read on. If bg-200 or the status colors change, update these and run tooling/test.mjs.
 */
const RANGE = {
  dark: { L: [0.7, 0.88], maxC: 0.16, ground: "#161a20", soft: { L: 0.27, C: 0.045, step: -0.01, stop: 0.16 } },
  light: { L: [0.4, 0.53], maxC: 0.16, ground: "#f8f9fb", soft: { L: 0.955, C: 0.03, step: 0.005, stop: 0.995 } }
};

/** The most chroma up to C at this lightness and hue that a screen can show. */
function fitGamut(L, C, h) {
  for (let c = C; c > 0; c -= 0.005) {
    const rgb = oklchToLinear(L, c, h);
    if (inGamut(rgb)) return rgb;
  }
  return oklchToLinear(L, 0, h);
}

function fitTheme(theme, position, C, h) {
  const r = RANGE[theme];
  const ground = luminance(hexToLinear(r.ground));
  let L = r.L[0] + position * (r.L[1] - r.L[0]);
  let text = fitGamut(L, Math.min(C, r.maxC), h);
  // Move away from the ground until it reads, in case a hue is unusually dark or light.
  const away = theme === "dark" ? 0.01 : -0.01;
  while (contrast(luminance(text), ground) < 4.5 && L > 0.05 && L < 0.98) {
    L += away;
    text = fitGamut(L, Math.min(C, r.maxC), h);
  }
  const y = luminance(text);
  const s = r.soft;
  let soft = fitGamut(s.L, Math.min(s.C, C), h);
  for (let sl = s.L; theme === "dark" ? sl >= s.stop : sl <= s.stop; sl += s.step) {
    soft = fitGamut(sl, Math.min(s.C, C), h);
    if (contrast(y, luminance(soft)) >= 4.5) break;
  }
  return { text: toHex(text), soft: toHex(soft) };
}

/**
 * A hex color fitted to the palette: the text color (text, dots, borders) and a tinted ground, per theme.
 * @param {string} hex #rrggbb
 * @returns {{ dark: { text: string, soft: string }, light: { text: string, soft: string } }}
 */
export function fitColor(hex) {
  const { L, C, h } = hexToOklch(UserColor.parse(hex));
  // Keep the color's lightness, relative to a usual 0.35 to 0.9 span, inside each theme's range:
  // lighter colors sit further from the ground in dark, and the order flips in light.
  const position = Math.min(1, Math.max(0, (L - 0.35) / 0.55));
  return { dark: fitTheme("dark", position, C, h), light: fitTheme("light", 1 - position, C, h) };
}

// ---- Seeds and random --------------------------------------------------------------------------

// FNV-1a, so a string seed maps to the same color in every browser and on the server.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const LEVELS = [0.9, 0.5, 0.1];

/** A representative color for a hue and lightness position, before fitting. */
const pick = (h, position) => toHex(fitGamut(0.45 + position * 0.4, 0.13, h));

// Number seeds walk a fixed sequence in which each next color is the one furthest, in both themes,
// from every color before it, so seeds 1 to N are as distinct as the palette allows for any N.
const sequence = [];
let candidates;

function oklab(hex) {
  const { L, C, h } = hexToOklch(hex);
  return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
}

function nthColor(n) {
  if (!candidates) {
    candidates = [];
    for (let h = 0; h < 360; h += 4) {
      for (const level of LEVELS) {
        const hex = pick(h, level);
        const f = fitColor(hex);
        candidates.push({ h, level: LEVELS.indexOf(level), hex, dark: oklab(f.dark.text), light: oklab(f.light.text) });
      }
    }
    // Start from a light blue, the calmest first color in both themes.
    sequence.push(candidates.reduce((a, c) => (Math.abs(c.h - 256) + c.level < Math.abs(a.h - 256) + a.level ? c : a)));
  }
  while (sequence.length <= n) {
    let best = null;
    let bestGap = -1;
    for (const c of candidates) {
      let gap = Infinity;
      for (const s of sequence) gap = Math.min(gap, Math.hypot(c.dark[0] - s.dark[0], c.dark[1] - s.dark[1], c.dark[2] - s.dark[2]), Math.hypot(c.light[0] - s.light[0], c.light[1] - s.light[1], c.light[2] - s.light[2]));
      if (gap > bestGap) [best, bestGap] = [c, gap];
    }
    sequence.push(best);
  }
  return sequence[n].hex;
}

/**
 * The color for a seed, the same every time. Strings ignore case and outer spaces.
 * Numbers walk a fixed most-distinct sequence, so seeds 1 to N differ as much as the palette allows.
 * @param {string | number} seed
 * @returns {string} #rrggbb, to pass as a color or store
 */
export function seedColor(seed) {
  if (typeof seed === "number") return nthColor(Math.max(0, Math.trunc(seed) - 1));
  const x = hash(String(seed).trim().toLowerCase());
  return pick(x % 360, LEVELS[Math.floor(x / 360) % LEVELS.length]);
}

/**
 * A random color, with its hue as far as it can get from the colors in avoid.
 * @param {{ avoid?: string[] }} [options] hex colors already used nearby
 * @returns {string} #rrggbb
 */
export function randomColor({ avoid = [] } = {}) {
  const used = avoid.filter((c) => UserColor.safeParse(c).success).map((c) => hexToOklch(c).h);
  let best = Math.random() * 360;
  if (used.length) {
    let gap = -1;
    for (let i = 0; i < 36; i++) {
      const h = Math.random() * 360;
      const d = Math.min(...used.map((u) => Math.min(Math.abs(h - u), 360 - Math.abs(h - u))));
      if (d > gap) [gap, best] = [d, h];
    }
  }
  return pick(best, LEVELS[Math.floor(Math.random() * LEVELS.length)]);
}

// ---- Using a color -----------------------------------------------------------------------------

/** @type {[number, string][]} */
const BANDS = [[15, "Rose"], [35, "Coral"], [65, "Orange"], [100, "Amber"], [118, "Olive"], [135, "Lime"], [170, "Green"], [195, "Teal"], [210, "Cyan"], [232, "Sky"], [275, "Blue"], [290, "Indigo"], [310, "Violet"], [325, "Purple"], [342, "Magenta"], [360, "Pink"]];

/** A plain name for a color's hue, for screen readers and tooltips, such as "Indigo". @param {string} hex */
export function colorName(hex) {
  const { L, C, h } = hexToOklch(hex);
  if (C < 0.03) return L > 0.6 ? "Light gray" : "Gray";
  return BANDS.find(([max]) => h < max)[1];
}

/**
 * CSS custom properties for a style attribute, from a provided color or else a seed. With the sd-cat
 * class on the same element, var(--cat) is the text color and var(--cat-soft) the tinted ground, and
 * both follow the theme.
 * @param {{ color?: string | null, seed?: string | number | null }} input
 */
export function colorStyle({ color, seed }) {
  const hex = color && UserColor.safeParse(color).success ? color : seed != null && seed !== "" ? seedColor(seed) : null;
  if (!hex) return "";
  const f = fitColor(hex);
  return `--cat-d: ${f.dark.text}; --cat-soft-d: ${f.dark.soft}; --cat-l: ${f.light.text}; --cat-soft-l: ${f.light.soft};`;
}
