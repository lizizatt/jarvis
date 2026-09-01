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

Click the trans flag or credit reading to open the Jarvis dashboard. Click CPU or RAM to inspect the system in a fresh `htop` terminal. Each registered repository has a distinct heart with its name in the tooltip. A grayed-out heart opens that repository in a new VS Code window; an active heart focuses its existing window. On Linux, the worker registers its focused window with this extension over the session D-Bus, providing exact activation even when VS Code shares one parent process. A green underline marks the focused window, yellow marks a recently active window, and dimmed workers are in the background. Host presence and activity refresh every two seconds; credits refresh every minute. When Jarvis is offline, the latest values remain visible but are dimmed.
