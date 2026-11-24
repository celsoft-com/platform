// A GitHub App's credentials for tests, with a real key so its tokens sign.

import type { GitHubApp } from "./github.ts";

export async function testApp(owner = "acme"): Promise<GitHubApp> {
  const keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { id: 7, slug: "platform-acme", owner, pem, webhook_secret: "hook", client_id: "client-id", client_secret: "client-secret" };
}
