// The Create token links: Cloudflare's account token page, opened with each step's permissions filled in.
// Permissions are named by Cloudflare's permission group IDs, which its page always resolves; short names it does not know are dropped.

const SETUP_KEYS = [
  { key: "e086da7e2179491d91ee5f35b3ca210a", type: "edit" }, // Workers Scripts Write
  { key: "c1fde68c7bcc44588cbb6ddbc16d6480", type: "read" }, // Account Settings Read
  { key: "1e13c5124ca64b72b1969a67e8829049", type: "edit" }, // Access: Apps and Policies Write
  { key: "bfe0d8686a584fa680f4c53b5eb0de6d", type: "edit" }, // Access: Organizations, Identity Providers, and Groups Write
];

const APP_KEYS = [
  ...SETUP_KEYS,
  { key: "721b2f51fba74871bd361de65aeb7e03", type: "edit" }, // Hyperdrive Write
  { key: "bf7481a1826f439697cb59a20b22293e", type: "edit" }, // Workers R2 Storage Write
  { key: "c8fed203ed3043cba015a93ad1616f1f", type: "read" }, // Zone Read
  { key: "4755a26eedb94da69e1066d98aa820be", type: "edit" }, // DNS Write
  { key: "28f4b596e7d643029c524985477ae49a", type: "edit" }, // Workers Routes Write
];

const tokenUrl = (keys: { key: string; type: string }[], name: string) =>
  `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&name=${encodeURIComponent(name)}`;

export const SETUP_TOKEN_URL = tokenUrl(SETUP_KEYS, "platform setup");
export const WIDER_TOKEN_URL = tokenUrl(APP_KEYS, "platform");
