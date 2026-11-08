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

## Production login

Open `https://monitor.ms903.org/admin#/admin` and use username `ms903`. The
dashboard password has already been separated from the Agent reporting secret.
Both locally managed values are stored only on the Home Server in the
mode-`0600` file `~/.config/cfsm-deploy/cfsm-secrets.env`:

- `ADMIN_PASSWORD` is the dashboard login password.
- `API_SECRET` is only for installing and authenticating Agents.

## US public-path bandwidth tests

The US repair adds iperf3 to the existing Home collector rather than using the
small QUIC samples. Each direction targets 64 MiB over four TCP streams; the
six-hour schedule is unchanged. The other seven address-family paths retain
their 4/2 MiB samples. The baseline payload budget is about 34.9 GiB per 30 days
for all nine paths, plus block alignment, retransmissions, protocol overhead,
retries, and manual tests.

Production activation status and the remaining deployment action are recorded
in `docs/us-speed-repair-20261108.md`. Do not enable the collector's US iperf
targets until the backend's new job budgets are live.

`deploy/family-path-bandwidth-profiles.json` is the production source for the
Worker's `FAMILY_PATH_BANDWIDTH_PROFILES` variable. Entries use stable server
IDs; removing an entry restores the default 4/2 MiB job budget. Deployments load
the same file into Wrangler. A collector's local limits must also allow the
larger samples.

The running collector's source is
`~/peer-relay-manager/cmd/cfsm-family-probe`; its iperf setup and rollback are
documented in `~/peer-relay-manager/docs/CFSM_IPERF.md`. Only targets with
`iperf_ssh_host` use the new engine. The Home host and those targets need
iperf3; SSH uses the existing host aliases and pinned host keys. Each temporary
VPS listener is restricted to the current SSH source IP and automatically
closes after one test, with a 90-second watchdog. No permanent public iperf
service is installed.
