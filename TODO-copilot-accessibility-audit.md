# Copilot Accessibility Audit TODO

These items are separate from the 2026-08-20 GNOME logout incident. The logout was caused by a GNOME Shell SIGSEGV; the observer defect below is real but cannot cause that session restart through its current control flow.

- [x] Fix native chat observer window matching: `monitor()` passed the decoded window-name list to `find_window()`, which wrapped it again before title matching. Added an executable regression test covering the JSON-array monitor path.
- [x] Fix GNOME extension request timeout cleanup: the five-second timeout removed its own GLib source, then `_fetch()` removed the same source ID again in `finally`, producing a `GLib-CRITICAL` on every timed-out request.
- [x] Make worker-window focus unambiguous when multiple VS Code windows share a workspace name or root basename; worker PIDs now identify the matching Code window, while ambiguous legacy title matches are refused.
- [x] Allocate worker flag emojis without using the current map size as the slot: a newly added worker now takes an available flag after another worker leaves.
- [x] Clear server-side `needs-input` task activity when an unanswered task completes or is abandoned; the GNOME extension correctly displays the server state.
- [x] Preserve the last Copilot credit count during `/api/copilot-usage` failures; CPU/RAM and credits now retain their last successful values.
- [x] Investigate the GNOME Shell SIGSEGV at 2026-08-20 12:36:08 PDT. The apport core shows the crashing thread in `g_object_ref` via `libatk-bridge-2.0` during AT-SPI/D-Bus dispatch inside GNOME Shell. No Jarvis JavaScript frame appears in the backtrace; this identifies the crash surface but does not prove whether the external AT-SPI observer triggered it.
