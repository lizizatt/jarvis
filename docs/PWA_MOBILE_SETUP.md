# PWA & Mobile Setup Guide

This guide covers installing and using Jarvis as a Progressive Web App (PWA) on phones and tablets.

## What is a PWA?

Jarvis is a Progressive Web App that:
- **Installs as a native app** on your phone (appears in app drawer)
- **Works offline** with cached assets (while tasks run on the laptop)
- **Receives Web Push notifications** for task updates
- **Auto-updates** without manual app store interaction
- **No account required** — all data stays on your laptop

## Prerequisites

- Phone or tablet connected to the same **Tailscale Tailnet** as your laptop, OR
- Phone on the same **local Wi-Fi network** as your laptop
- Browser: Chrome, Safari, Firefox, or Edge
- HTTPS access (automatic via Tailscale Serve; self-signed over LAN)

## Setup via Tailscale Serve (Recommended)

### On your laptop

```bash
# Enable Tailscale Serve to expose Jarvis over HTTPS
tailscale serve --bg http://127.0.0.1:3210
```

This creates a Tailnet-accessible HTTPS endpoint at:
```
https://<laptop-name>.<tailnet>.ts.net/
```

For example: `https://alexandria.test.ts.net/`

**Note:** Replace `<laptop-name>` and `<tailnet>` with your device and Tailnet names.

To verify:
```bash
# Check the endpoint
tailscale status | grep "Serve"

# Test from your phone's browser
# Should redirect and show Jarvis dashboard
```

### On your phone

1. **Open the browser** to your Jarvis URL:
   - Copy-paste or share: `https://<laptop-name>.<tailnet>.ts.net/`
   - You should see the Jarvis dashboard

2. **Install as PWA**:
   - **Safari (iOS):** Tap Share → Add to Home Screen
   - **Chrome (Android):** Tap menu ⋮ → Install app → Install
   - **Firefox (Android):** Tap menu ⋮ → Install → Install
   - **Edge:** Tap menu ⋮ → Apps → Install this site

3. **Access the app**:
   - Open from your home screen / app drawer (icon: "Jarvis")
   - The app auto-updates when you visit the laptop's URL
   - Push notifications appear when tasks complete or need your response

### Troubleshooting Tailscale Serve

**"Install" button doesn't appear:**
- Ensure HTTPS is enabled (check address bar for 🔒)
- Try a different browser (Safari, Chrome, Firefox)
- Private/incognito mode sometimes works better
- Clear browser cache: Settings → Privacy → Clear browsing data

**Can't reach the URL from phone:**
- Verify phone is connected to the Tailnet: Settings → Tailscale → Status
- Verify laptop is running Jarvis: `systemctl --user status jarvis`
- Check Tailscale Serve is enabled: `tailscale status | grep Serve`
- Ping the laptop from phone: `tailscale ping <laptop-name>` (terminal/SSH)

**Notifications don't work:**
- Ensure PWA is installed (not just bookmarked)
- PWA must have "Notifications" permission: Browser settings → Jarvis → Notifications → Allow
- Laptop server must be running (check `systemctl --user status jarvis`)
- Check browser console for errors (F12 → Console)

**App keeps redirecting to browser:**
- HTTPS certificate is untrusted; accept it and try again
- Tailscale Serve provisions a trusted TLS certificate for the device name

## Setup via LAN (Local Network Fallback)

For testing without Tailscale, you can bind Jarvis to your LAN interface.

### On your laptop

1. **Find your LAN IP address:**
   ```bash
   hostname -I | awk '{print $1}'
   # Example: 192.168.1.100
   ```

2. **Create a self-signed certificate:**
   ```bash
   LAPTOP_IP="192.168.1.100"
   openssl req -x509 -newkey rsa:2048 \
     -keyout /tmp/key.pem -out /tmp/cert.pem \
     -days 365 -nodes \
     -subj "/CN=$LAPTOP_IP/O=Jarvis/C=US"
   ```

3. **Set up a reverse proxy** (nginx or Caddy):

   **Option A: Using Caddy (simpler)**
   ```bash
   # Install Caddy: https://caddyserver.com/download

   # Create a Caddyfile:
   tee /tmp/Caddyfile <<EOF
   :3211

   tls /tmp/cert.pem /tmp/key.pem

   reverse_proxy http://127.0.0.1:3210
   EOF

   # Run Caddy
   caddy run --config /tmp/Caddyfile
   ```

   **Option B: Using nginx**
   ```bash
   # Install nginx and configure with the certificate, then:
   nginx -c /path/to/nginx.conf
   ```

4. **Bind Jarvis server to LAN interface** (optional alternative):
   ```bash
   JARVIS_HOST=192.168.1.100 JARVIS_PORT=3210 npm --workspace @jarvis/server start
   ```
   Then manually set up HTTPS with a reverse proxy on port 3211 or 443.

### On your phone

1. **Open browser** to your laptop's LAN IP:
   - `https://192.168.1.100:3211` (if using Caddy on 3211)
   - You'll see a certificate warning (expected, self-signed)

2. **Accept the certificate**:
   - Tap "Advanced" or "Details"
   - Tap "Proceed" or "Visit This Website"

3. **Install as PWA**:
   - Same as Tailscale Serve (see above)

### Troubleshooting LAN Setup

**"Can't reach the server":**
- Verify phone is on the same Wi-Fi: Settings → Wi-Fi → <network-name>
- Verify laptop IP: `hostname -I`
- Check firewall isn't blocking port 3211: `sudo ufw status` (if using ufw)
- Ping from phone: `ping 192.168.1.100` (terminal/SSH)

**Certificate warning persists:**
- Self-signed certs always show warnings; this is normal and expected
- Browsers allow "Advanced" → "Proceed" to bypass
- For production, use a proper CA (Let's Encrypt, corporate CA, etc.)

**HTTPS doesn't work:**
- Verify reverse proxy is running: `curl https://192.168.1.100:3211 -k`
- Check certificate file paths in nginx/Caddy config
- View proxy logs: `journalctl -u caddy` or `tail -f /var/log/nginx/error.log`

## Using the PWA

### Dashboard

The home screen shows:
- **Registered repositories** with branch, dirty status, and current task
- **Server-managed repository list** (the phone is read-only for inventory)
- Task count and elapsed time per repo

Tap a repository to view details.

### Repository Detail

Shows:
- **Task canvas:** Live event timeline with agent messages, tool calls, and questions
- **Chat input:** Send follow-up messages or answers to the agent
- **Stop button:** Terminates the task (always visible while running)
- **Terminal tab:** Interactive shell in the checkout directory
- **Diff tab:** Latest uncommitted changes
- **PR tab:** Pull request and check status
- **Previews:** Links to generated HTML in the repository

### Notifications

When a task completes, needs your input, or a PR finishes:
- **Browser notification** appears (if PWA permissions granted)
- **Tap notification** to jump to the relevant task or repository
- Notification center keeps a history (device settings)

**To enable notifications:**
1. PWA menu (long-press app icon or menu button)
2. Tap "Notifications"
3. Allow notifications

### Offline Behavior

- **Cached pages:** Dashboard, completed tasks, and past events are readable offline
- **Live updates:** Cannot receive new messages or updates while offline
- **Terminal & tasks:** Cannot start new tasks; existing tasks continue on the laptop

When the connection is restored, the PWA auto-syncs.

### Auto-Update

The PWA checks for updates every time you:
- Switch to the app
- Revisit the URL in the browser (manual refresh)
- After 12 hours (automatic background check)

No app store action needed; updates are automatic and silent.

## Push Notifications

### How they work

1. **First time you open the PWA**, the app asks: "Allow notifications?"
   - Tap "Allow" to receive push notifications
   - Subscription is stored locally in `~/.jarvis` (not synced to cloud)

2. **When a task completes, fails, or needs input:**
   - Server sends a Web Push notification
   - Appears in your phone's notification center
   - Tap to return to the app and the relevant task

3. **Notification types:**
   - Task started (background, no notification)
   - Task completed (notification: "Task 'Add tests' completed")
   - Task failed (notification: "Task 'Add tests' failed")
   - Task needs approval (notification: "Agent asks before commit")
   - PR/check completed (notification: "Check passed on feature-x")

### Troubleshooting notifications

**Notifications don't appear:**
1. Check browser permissions: Settings → Jarvis → Notifications → Allow
2. Verify server is running: `systemctl --user status jarvis`
3. Check phone's notification settings (some phones restrict background services)
4. Open the app and check console (F12) for errors

**Subscription lost after uninstall:**
- Uninstalling the PWA clears the subscription
- Reinstalling creates a new subscription
- Old subscriptions are cleaned up automatically after 7 days

## Security Notes

- **HTTPS is required** for notifications and PWA installation (browser limitation)
- **Tailscale Serve provisions trusted TLS certificates** for the device's `ts.net` name
- **LAN mode requires manual certificate setup** for production use
- **Never expose Jarvis to the public Internet** (bind to Tailscale or private LAN only)
- **Full shell access:** The PWA provides unrestricted terminal access to the laptop user (this is intentional)

## Testing on Multiple Devices

You can install the PWA on multiple phones/tablets in the same Tailnet:

1. Each device gets a separate PWA instance
2. All devices see the same task canvas and repository state (real-time sync)
3. Multiple devices can monitor the same task without conflicts
4. Notifications go to all devices with active subscriptions

## Advanced: Custom Icons & Branding

The PWA icon and name are defined in `apps/web/vite.config.ts`:

```typescript
manifest: {
  name: 'Jarvis Developer Control',
  short_name: 'Jarvis',
  theme_color: '#173d34',
  background_color: '#f3f6f1',
  icons: [{ src: '/icon.svg', ... }]
}
```

To customize:
1. Edit the manifest in `vite.config.ts`
2. Replace `/public/icon.svg` with your icon
3. Rebuild: `npm run build --workspace @jarvis/web`
4. Restart server: `systemctl --user restart jarvis`
5. Force reload in browser: Ctrl+Shift+R (or Cmd+Shift+R on Mac)

## Debugging

### Browser Console (F12)

View errors and WebSocket events:
1. Open DevTools: F12 (or Cmd+Option+I on Mac)
2. Console tab shows JavaScript errors
3. Network tab shows API calls and WebSocket messages
4. Application tab shows PWA cache and storage

### Server Logs

From your laptop:
```bash
journalctl --user -u jarvis -f
```

Look for:
- Connection events: "WebSocket opened"
- Task events: "Task started", "Task stopped"
- Errors: Any error messages with timestamps

## Performance Tips

- **Limit concurrent devices:** Each WebSocket connection uses server memory
- **Archive old tasks:** Manually delete old task events from SQLite if needed
- **Reduce notification frequency:** Disable non-critical notifications in app settings
- **Use Tailscale Serve:** More efficient than LAN mode with self-signed certs

## Further Support

- **Installation issues:** See [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Configuration options:** See [CONFIGURATION.md](./CONFIGURATION.md)
- **General help:** See [README.md](../README.md)
