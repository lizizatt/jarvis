# Jarvis GNOME System Status

This GNOME Shell 46 extension adds a compact top-panel view of the same CPU, RAM, and Copilot credit readings shown on Jarvis's home page. It reads the local Jarvis server at `http://127.0.0.1:3210`, so it does not expose or transmit metrics elsewhere.

Install the package for the current user:

```bash
bash deploy/gnome-shell/install-jarvis-system-status.sh
```

GNOME Shell scans manually installed extensions when the desktop session starts. Log out and back in, then enable it:

```bash
gnome-extensions enable jarvis-system-status@jarvis
```

The panel item opens the local Jarvis dashboard when clicked. CPU and RAM refresh every two seconds; credits refresh every minute. When Jarvis is offline, the latest values remain visible but are dimmed.
