# platform

An open-source platform each org deploys once, as its own Platform Instance, to deploy its apps to
Cloudflare Workers with a Neon Postgres database, prod on every push to main and a full preview for
every pull request.

## Start here

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/celsoft-com/platform)

You need a Cloudflare account on Workers Paid and a GitHub account. The button copies this repo
into your GitHub account and deploys it; [SETUP.md](SETUP.md) walks through the rest of initial
setup, about five minutes in the browser.

Apps can't be added to an instance yet; that comes with complete setup. Nothing is published to
npm any more.

- **How it works:** [docs/how-it-works.md](docs/how-it-works.md)
- **Design:** [docs/design.md](docs/design.md), the Platform Instance in section 16
- **Setup:** [SETUP.md](SETUP.md)
- **Demo:** [apps/demo](apps/demo), deployed by this repo's own workflow
