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

Click CPU or RAM to inspect the system in a fresh `htop` terminal, or click the credit reading to open the Jarvis dashboard. Each Copilot worker has its own tooltip and focuses its VS Code window when clicked. On Linux, the worker registers its focused window with this extension over the session D-Bus, providing exact activation even when VS Code shares one parent process. A green underline marks the focused window, yellow marks a recently active window, and dimmed workers are in the background. Idle sessions alternate between pride and trans flags, active Jarvis or visible Copilot Chat sessions show a thinking bubble, and sessions waiting for input show a stop sign. Host presence and activity refresh every two seconds; credits refresh every minute. Native Copilot Chat activity requires the worker's Linux AT-SPI observer and VS Code accessibility support. When Jarvis is offline, the latest values remain visible but are dimmed.
