# PWA Mobile Setup

Jarvis is intended to remain bound to localhost and reach a phone through private Tailscale Serve HTTPS. HTTPS is required for installation and Web Push.

## Publish to the Tailnet

On the laptop:

```bash
systemctl --user is-active jarvis
systemctl --user is-active jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/readiness
curl -fsS http://127.0.0.1:3210/
tailscale serve --bg http://127.0.0.1:3210
tailscale status
```

Open the displayed `https://<device>.<tailnet>.ts.net/` URL from a phone connected to the same Tailnet.

Do not bind Jarvis to a public interface or publish it through a public tunnel. The UI exposes registered repository content and a shell running with the desktop user's permissions.

## Install

- iPhone/iPad Safari: Share, then **Add to Home Screen**.
- Android Chrome: browser menu, then **Install app** or **Add to Home screen**.
- Edge: browser menu, **Apps**, then **Install this site**.

Browser wording varies by version. Open the installed app once and allow notifications if desired.

## Updates

Production web assets come from `apps/web/dist`. Publish a web change with:

```bash
npm run build --workspace @jarvis/web
```

No Jarvis service restart is required. The service worker uses auto-update registration, but an already open PWA may continue using its current assets until it reloads. Close and reopen the app when verifying a new build.

## Troubleshooting

### URL is unreachable

```bash
systemctl --user is-active jarvis
systemctl --user is-active jarvis-terminal-host
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS http://127.0.0.1:3210/api/readiness
curl -fsS http://127.0.0.1:3210/
tailscale status
journalctl --user -u jarvis -n 100 --no-pager
```

Confirm the phone and laptop are in the same Tailnet and allowed by its policy.

### Install option is absent

- Confirm the URL is HTTPS and uses the Tailscale device name.
- Try the browser's share/app menu rather than waiting for an install prompt.
- Reload after the page finishes loading.

### A new build looks stale

- Confirm `apps/web/dist` was rebuilt.
- Close every PWA window and reopen it.
- If needed, remove the installed app/site data and install it again.

### Notifications are absent

- Confirm notification permission is enabled for the installed app.
- Keep the laptop, Jarvis services, and Tailscale connection running.
- Inspect browser developer tools and Jarvis logs for subscription or delivery errors.

For service deployment see [Deployment](DEPLOYMENT.md). For bind and data settings see [Configuration](CONFIGURATION.md).
