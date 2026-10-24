import { describe, expect, it, vi } from "vitest";
import { createEmail } from "./email.js";

const message = { to: "a@example.com", subject: "Hi", text: "Hello" };

describe("createEmail", () => {
  it("sends through Resend from the platform's noreply address", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    await createEmail({ EMAIL_MODE: "send", EMAIL_FROM: "noreply@app.example.com", EMAIL_API_KEY: "k" }, fetcher).send(message);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body as string)).toEqual({ from: "noreply@app.example.com", ...message });
  });

  it("only logs in capture mode", async () => {
    const fetcher = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createEmail({ EMAIL_MODE: "capture" }, fetcher).send(message);
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toMatch(/email captured.*a@example\.com/);
    log.mockRestore();
  });

  it("explains a missing email setup", async () => {
    await expect(createEmail({}).send(message)).rejects.toThrow(/platform\.jsonc/);
  });
});
