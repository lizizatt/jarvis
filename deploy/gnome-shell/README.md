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

Click the trans flag or credit reading to open the Jarvis dashboard. Click CPU or RAM to inspect the system in a fresh `htop` terminal. Each registered repository has a distinct heart with its name, checked-out branch, and Git clean/dirty status in the tooltip. Dirty means tracked changes or conflicts; untracked-only files are shown as `clean (untracked files)`. Detached checkouts show `detached HEAD` instead of a branch name.

A grayed-out heart opens that repository in a new VS Code window; an active heart focuses its existing window. On Linux, the worker registers its focused window with this extension over the session D-Bus, providing exact activation even when VS Code shares one parent process. A green underline marks the focused window, yellow marks a recently active window, and dimmed workers are in the background. Host presence, activity, and repository lists refresh every two seconds. Git status reads use the same cadence on an independent HTTP session and a FIFO queue, with at most two active reads total and one queued or active read per repository. Credits refresh every minute. When Jarvis is offline, the latest values remain visible but are dimmed.

Repository registration persists in Jarvis's SQLite database, and Git status is read directly from each checkout, independently of Copilot sessions. Closing VS Code does not remove branch or clean/dirty information, and changes made outside Copilot appear on the next successful refresh. No worker-written state file is needed. While a status request is pending, its current values remain visible and other hearts keep updating. If the request fails, previous values are marked `last known`; before any successful read, the tooltip shows `Branch: unknown` and `Git: unavailable`.
