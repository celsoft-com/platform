export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailBindings {
  EMAIL_MODE?: "send" | "capture";
  // In capture mode, where captured messages go instead of the logs: tests read them here.
  EMAIL_OUTBOX?: EmailMessage[];
  EMAIL_FROM?: string;
  EMAIL_API_KEY?: string;
  // In capture mode, the addresses that are really emailed anyway: exact, or `*@domain`.
  EMAIL_SEND_TO?: string;
}

function allowed(to: string, list: string | undefined): boolean {
  const address = to.trim().toLowerCase();
  return (list ?? "").split(",").some((entry) => entry !== "" && (entry === address || (entry.startsWith("*@") && address.endsWith(entry.slice(1)))));
}

export interface Email {
  send(message: EmailMessage): Promise<void>;
}

// Previews capture instead of sending, so a copy of prod data never emails real users; captured
// messages land in the Worker's logs. Only the addresses a project lists for previews get mail.
export function createEmail(env: EmailBindings, fetcher: typeof fetch = fetch): Email {
  return {
    async send(message) {
      if (!env.EMAIL_MODE) throw new Error("this app has no email; add `email` to platform.jsonc");
      if (env.EMAIL_MODE === "capture" && !(env.EMAIL_API_KEY && allowed(message.to, env.EMAIL_SEND_TO))) {
        if (env.EMAIL_OUTBOX) env.EMAIL_OUTBOX.push(message);
        else console.log(`[email captured] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
        return;
      }
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, ...message }),
      });
      if (!response.ok) throw new Error(`sending email failed: ${response.status} ${await response.text()}`);
    },
  };
}
