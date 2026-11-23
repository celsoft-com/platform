# Setup

Initial setup of a Platform Instance, all in the browser. [docs/design.md](docs/design.md)
section 16 is the full design, including what happens in each state.

## You need

1. **Cloudflare:** an account on the Workers Paid plan.
2. **GitHub:** an account, or an org, to hold your copy of this repo.

## Steps

1. **Start:** on this repo's GitHub page, click **Deploy to Cloudflare**.
2. **Sign in:** sign in to Cloudflare. The first time, connect GitHub and pick the account or org
   that will hold the copy.
3. **Create:** confirm the repo and Worker names, `platform` by default, and click **Create and
   deploy**. The build runs on Cloudflare and takes about two minutes.
4. **Open it:** visit the Worker's address, which shows the setup form.
5. **Reserve it:** click **Create token**. The Cloudflare dashboard opens with the token's
   permissions filled in; create it, copy it, paste it into the form with your email, and submit.
6. **Claim it:** the page lists what setup did and says one step is left. Click **Sign in as**
   your email, enter the code Cloudflare emails to that same address, and you are the super admin.

## After you sign in

Setup has two steps; each checks its own work and says what it confirmed, or what stopped it.

1. **Token:** create a token with the listed permissions, the zone ones on all zones, and paste
   it. It replaces the setup token.
2. **GitHub App:** name the GitHub org your app repos live in, or leave it empty for your own
   account, then create the app on GitHub. Installing it on a repo happens when you add that app.

Then you are in the admin interface: Apps, and Settings, where you connect Neon (a Neon
organization API key) and Resend (an API key with Full access) and name platform admins whenever
you want.

## Adding an app

1. **Open Apps** and click **Add app**.
2. **Name the repo:** `owner/name` or its link, and its folder if the app is not at the root;
   click **Read repo**. The page shows what the app needs and whether the instance's GitHub App is
   on the repo.
3. **Install the GitHub App, if you want pushes to deploy:** click **Install on this repo**, which
   picks that repo alone, then **Check again**. Without it, the app deploys new releases or follows
   its default branch.
4. **Fill in:** a name, an address under one of your domains such as `notes.example.com`, the app's
   admins, and how it updates. Leave the build commands empty to use the repo's own.
5. **Click Add and deploy:** the app's page shows each step as it runs, and links to the app once
   it is live. A database needs a Neon key in Settings, and email a Resend key.

## Getting back in

1. **Restarted before Create and deploy:** click the button again.
2. **Restarted after it:** the build carries on without you; open the Worker's address from
   **Workers & Pages** in the Cloudflare dashboard.
3. **Lost the token before pasting it:** Cloudflare shows a token once, so create another and
   delete the unused one.
4. **Token refused:** the form says why; fix it and submit again.
5. **Mistyped email, restarted while waiting, or the code expired:** submit a token with the right
   email again, or ask Cloudflare's sign-in for a new code.
6. **Access not switched on:** if the form says so, open **Zero Trust** in the dashboard, click
   **Enable Access**, choose the Free plan, and submit again.
7. **Lost access to your email later:** open the instance's address, click **Lost access to your
   sign-in email?**, and submit a fresh token with your new email.

## Keep it safe

1. **Your copy of the repo:** Cloudflare deploys every push to its `main`, so give push access only
   to super admins.
2. **The Cloudflare account:** anyone who is a member can go around the instance, so keep members
   to super admins.
