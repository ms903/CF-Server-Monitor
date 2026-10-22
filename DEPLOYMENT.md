# ms903 production deployment

This fork deploys the monitoring service to `https://monitor.ms903.org` through
GitHub Actions.

## Architecture

- Cloudflare Worker: `cf-server-monitor`
- Custom domain: `monitor.ms903.org`
- D1 binding: `DB` -> `server-monitor-db`
- Durable Object binding: `METRICS_BROADCASTER`
- Agent/reporting secret: encrypted Worker secret `API_SECRET`

The GitHub workflow creates the Wrangler configuration at deploy time. It keeps
`API_SECRET` out of `wrangler.toml` and uploads it through Wrangler's encrypted
secret mechanism.

## Required GitHub Actions secrets

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `D1_DATABASE_ID`
- `API_SECRET`

Pushes to `main` deploy production automatically. Scheduled upstream sync is
disabled because upstream workflow changes must be reviewed before they reach
production; run **Upstream Sync** manually when an upstream update is wanted.

## First login

Open `https://monitor.ms903.org/admin#/admin`. The initial username is `ms903`
and the initial password is the Worker `API_SECRET`. Change the dashboard login
password after the first login; Agent reporting continues to use `API_SECRET`.
