// The super admin's settings, one category per connection, rendered by Service Dark's Settings.
import { z } from "zod";

// Write-only: the page never holds a saved key, so these are drawn by a custom page that shows only whether one is set.
const secret = (title: string, description: string, placeholder: string) => z.string().default("").meta({ title, description, placeholder });

export const InstanceSettings = z.object({
  cloudflare: z
    .object({ token: secret("API token", "The instance's Cloudflare token. A new one is checked for every permission on every domain before it replaces this one.", "Paste a new token") })
    .meta({ title: "Cloudflare", icon: "cloud", description: "The token the instance uses for your account." }),
  github: z
    .object({
      app: z.string().default("").meta({ title: "GitHub App", description: "The instance's own private app.", mono: true, readOnly: true }),
      owner: z.string().default("").meta({ title: "Owner", description: "Where the app belongs, and where app repos must live.", mono: true, readOnly: true }),
    })
    .meta({ title: "GitHub", icon: "git-branch", description: "Reads app repos and hears their pushes and pull requests." }),
  database: z
    .object({ neonKey: secret("Neon API key", "An organization API key; the instance makes each app's database with it.", "Paste a Neon organization API key") })
    .meta({ title: "Database", icon: "database", description: "Where apps' databases live." }),
  email: z
    .object({ resendKey: secret("Resend API key", "A key with Full access; the instance adds each app's sending domain with it.", "Paste a Resend API key") })
    .meta({ title: "Email", icon: "mail", description: "How apps send email." }),
  admins: z
    .object({
      emails: z
        .array(z.email("Enter a valid email address, like ann@example.com."))
        .default([])
        .meta({ title: "Platform admins", description: "People who add and manage apps. They sign in with an emailed code and never see these settings." }),
    })
    .meta({ title: "Platform admins", icon: "users", description: "Who manages apps.", save: "button" }),
});

export type InstanceSettings = z.infer<typeof InstanceSettings>;
