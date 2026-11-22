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

## Complete setup

Once you are signed in, your home page is a checklist. Work down it; each step checks its own work
and shows ✓ when it is done, or says what stopped it.

1. **Wider token:** create a token with the listed permissions, the zone ones on all zones, and
   paste it. It replaces the setup token.
2. **GitHub App:** name the GitHub org your app repos live in, or leave it empty for your own
   account, then create the app on GitHub. Installing it on a repo happens when you add that app.
3. **Database:** paste a Neon organization API key.
4. **Email:** paste a Resend API key with Full access.
5. **Platform admins:** list the emails of the people who will manage apps.

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
7. **Lost access to your email later:** open `/reset` on the instance and submit a fresh token
   with your new email.

## Keep it safe

1. **Your copy of the repo:** Cloudflare deploys every push to its `main`, so give push access only
   to super admins.
2. **The Cloudflare account:** anyone who is a member can go around the instance, so keep members
   to super admins.
