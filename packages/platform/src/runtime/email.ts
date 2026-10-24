export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailBindings {
  EMAIL_MODE?: "send" | "capture";
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  EMAIL_API_KEY?: string;
}

export interface Email {
  send(message: EmailMessage): Promise<void>;
}

// Previews capture instead of sending, so a copy of prod data never emails real users;
// captured messages land in the Worker's logs.
export function createEmail(env: EmailBindings, fetcher: typeof fetch = fetch): Email {
  return {
    async send(message) {
      if (!env.EMAIL_MODE) throw new Error("this app has no email; add `email` to platform.jsonc");
      if (env.EMAIL_MODE === "capture") {
        console.log(`[email captured] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
        return;
      }
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, reply_to: env.EMAIL_REPLY_TO, ...message }),
      });
      if (!response.ok) throw new Error(`sending email failed: ${response.status} ${await response.text()}`);
    },
  };
}
