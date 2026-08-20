#!/usr/bin/python3

import argparse
import json
import re
import sys
import time

CONTROL_ROLES = {"button", "push button", "toggle button"}
THINKING_CONTROLS = {
    "cancel", "cancel generation", "cancel request", "cancel response",
    "stop", "stop generating", "stop generating response", "stop response",
}
NEEDS_INPUT_PREFIXES = ("allow", "approve", "confirm", "continue")
CHAT_ANCESTOR_PATTERN = re.compile(r"(?:^|\b)(?:agent|chat|copilot)(?:\b|$)", re.IGNORECASE)


def normalize(value):
    return " ".join(str(value or "").casefold().split())


def classify(controls):
    activity = "idle"
    for control in controls:
        if normalize(control.get("role")) not in CONTROL_ROLES:
            continue
        ancestors = control.get("ancestors")
        if not isinstance(ancestors, list) or not any(CHAT_ANCESTOR_PATTERN.search(str(name)) for name in ancestors):
            continue
        name = normalize(control.get("name")).split(" (", 1)[0]
        if name.startswith(NEEDS_INPUT_PREFIXES):
            return "needs-input"
        if name in THINKING_CONTROLS:
            activity = "thinking"
    return activity


def accessible_name(accessible):
    try:
        return accessible.get_name() or ""
    except Exception:
        return ""


def visible(accessible, atspi):
    try:
        states = accessible.get_state_set()
        return states.contains(atspi.StateType.SHOWING) and states.contains(atspi.StateType.VISIBLE)
    except Exception:
        return False


def ancestor_names(accessible, atspi):
    names = []
    try:
        ancestor = accessible.get_parent()
        while ancestor and len(names) < 12:
            role = ancestor.get_role()
            if role not in {atspi.Role.TEXT, atspi.Role.ENTRY, atspi.Role.PARAGRAPH}:
                name = accessible_name(ancestor)
                if name:
                    names.append(name)
            ancestor = ancestor.get_parent()
    except Exception:
        pass
    return names


def controls_in(frame, atspi):
    controls = []
    pending = [frame]
    visited = 0
    while pending and visited < 5000:
        accessible = pending.pop()
        visited += 1
        try:
            role_name = normalize(accessible.get_role_name())
            if role_name in CONTROL_ROLES and visible(accessible, atspi):
                controls.append({
                    "role": role_name,
                    "name": accessible_name(accessible),
                    "ancestors": ancestor_names(accessible, atspi),
                })
            for index in range(accessible.get_child_count()):
                child = accessible.get_child_at_index(index)
                if child:
                    pending.append(child)
        except Exception:
            continue
    return controls


def find_window(atspi, window_names):
    desktop = atspi.get_desktop(0)
    pending = [desktop]
    visited = 0
    while pending and visited < 200:
        accessible = pending.pop()
        visited += 1
        try:
            if accessible.get_role() == atspi.Role.FRAME and window_title_matches(accessible_name(accessible), window_names):
                return accessible
            for index in range(accessible.get_child_count()):
                child = accessible.get_child_at_index(index)
                if child:
                    pending.append(child)
        except Exception:
            continue
    return None


def parse_window_names(value):
    try:
        window_names = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        window_names = [value]
    return window_names if isinstance(window_names, list) else [value]


def window_title_matches(title, names):
    if not isinstance(title, str) or not isinstance(names, list):
        return False
    parts = [part.strip().casefold() for part in title.split(" - ")]
    normalized = [str(name).strip().casefold() for name in names if str(name).strip()]
    return any(name in parts for name in normalized)


def monitor(window_name):
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    Atspi.init()
    window_names = parse_window_names(window_name)
    previous = None
    while True:
        frame = find_window(Atspi, window_names)
        activity = classify(controls_in(frame, Atspi)) if frame else "idle"
        if activity != previous:
            print(activity, flush=True)
            previous = activity
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--classify")
    parser.add_argument("--match-window")
    parser.add_argument("--match-monitor-window")
    parser.add_argument("--window")
    args = parser.parse_args()
    if args.classify is not None:
        print(classify(json.loads(args.classify)))
        return
    if args.match_window is not None:
        value = json.loads(args.match_window)
        print(str(window_title_matches(value.get("title"), value.get("names"))).lower())
        return
    if args.match_monitor_window is not None:
        value = json.loads(args.match_monitor_window)
        print(str(window_title_matches(value.get("title"), parse_window_names(value.get("window")))).lower())
        return
    if not args.window:
        parser.error("--window is required")
    monitor(args.window)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
