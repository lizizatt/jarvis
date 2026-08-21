import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const POLL_INTERVAL_SECONDS = 2;
const CREDIT_POLL_INTERVAL_SECONDS = 60;
const DASHBOARD_URL = 'http://127.0.0.1:3210/';
const SESSION_FLAGS = ['🏳️‍🌈', '🏳️‍⚧️'];

function percent(used, total) {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

const JarvisIndicator = GObject.registerClass(
class JarvisIndicator extends PanelMenu.Button {
  _init() {
    super._init(0.0, 'Jarvis system status', false);
    this.add_style_class_name('jarvis-system-status-indicator');
  }
});

export default class JarvisSystemStatusExtension extends Extension {
  enable() {
    this._session = new Soup.Session();
    this._indicator = new JarvisIndicator();
    this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
    this._cpu = this._clickableLabel('CPU --%', () => this._launchHtop());
    this._memory = this._clickableLabel('RAM --%', () => this._launchHtop());
    this._creditText = 'CR --';
    this._credits = this._clickableLabel(this._creditText, () => this._openUrl(DASHBOARD_URL));
    this._workersBox = new St.BoxLayout();
    this._workerActors = new Map();
    this._workersRefreshInFlight = false;
    this._box.add_child(this._cpu);
    this._box.add_child(new St.Label({ text: '  ', y_align: Clutter.ActorAlign.CENTER }));
    this._box.add_child(this._memory);
    this._box.add_child(new St.Label({ text: '  ', y_align: Clutter.ActorAlign.CENTER }));
    this._box.add_child(this._credits);
    this._box.add_child(this._workersBox);
    this._indicator.add_child(this._box);
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    this._refreshMetrics();
    this._refreshCredits();
    this._refreshWorkers();
    this._metricsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
      this._refreshMetrics();
      return GLib.SOURCE_CONTINUE;
    });
    this._creditsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CREDIT_POLL_INTERVAL_SECONDS, () => {
      this._refreshCredits();
      return GLib.SOURCE_CONTINUE;
    });
    this._workersTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
      this._refreshWorkers();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    if (this._metricsTimer) GLib.Source.remove(this._metricsTimer);
    if (this._creditsTimer) GLib.Source.remove(this._creditsTimer);
    if (this._workersTimer) GLib.Source.remove(this._workersTimer);
    this._metricsTimer = null;
    this._creditsTimer = null;
    this._workersTimer = null;
    this._session?.abort();
    this._session = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._box = null;
    this._cpu = null;
    this._memory = null;
    this._credits = null;
    this._workersBox = null;
    this._workerActors = null;
    this._workersRefreshInFlight = false;
    this._sessionFlags = null;
  }

  _clickableLabel(text, activate) {
    const label = new St.Label({ text, y_align: Clutter.ActorAlign.CENTER, reactive: true, track_hover: true });
    label.add_style_class_name('jarvis-status-item');
    label.connect('button-press-event', (_actor, event) => {
      if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
      activate();
      return Clutter.EVENT_STOP;
    });
    return label;
  }

  _launchHtop() {
    try {
      Gio.Subprocess.new(['gnome-terminal', '--', 'htop'], Gio.SubprocessFlags.NONE);
    } catch (error) {
      console.error(`Jarvis system status: unable to launch htop: ${error.message}`);
    }
  }

  _openUrl(url) {
    try {
      Gio.AppInfo.launch_default_for_uri(url, null);
    } catch (error) {
      console.error(`Jarvis system status: unable to open ${url}: ${error.message}`);
    }
  }

  async _fetch(path) {
    const session = this._session;
    if (!session) return null;
    const message = Soup.Message.new('GET', `${DASHBOARD_URL}api/${path}`);
    const cancellable = Gio.Cancellable.new();
    let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
      cancellable.cancel();
      timeout = 0;
      return GLib.SOURCE_REMOVE;
    });
    try {
      const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
      if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
      return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    } catch (error) {
      console.debug(`Jarvis system status: ${error.message}`);
      return null;
    } finally {
      if (timeout) {
        GLib.Source.remove(timeout);
        timeout = 0;
      }
    }
  }

  async _refreshMetrics() {
    const metrics = await this._fetch('metrics');
    if (!this._indicator) return;
    this._box.remove_style_class_name('jarvis-system-status-offline');
    if (!metrics) {
      this._box.add_style_class_name('jarvis-system-status-offline');
      return;
    }
    this._cpu.text = `CPU ${Math.round(metrics.cpuPercent)}%`;
    this._memory.text = `RAM ${percent(metrics.memoryUsedBytes, metrics.memoryTotalBytes)}%`;
  }

  async _refreshCredits() {
    const credits = await this._fetch('copilot-usage');
    if (!this._credits) return;
    if (!credits || typeof credits.creditsUsed !== 'number' || !Number.isFinite(credits.creditsUsed)) return;
    this._creditText = `CR ${credits.creditsUsed.toLocaleString()}`;
    this._credits.text = this._creditText;
  }

  async _refreshWorkers() {
    if (this._workersRefreshInFlight) return;
    this._workersRefreshInFlight = true;
    try {
      const workers = await this._fetch('workers');
      if (!workers || !this._workersBox) return;
      const currentWorkerIds = new Set(workers.map((worker) => worker.workerId));
      for (const [workerId, actor] of this._workerActors) {
        if (!currentWorkerIds.has(workerId)) {
          actor.destroy();
          this._workerActors.delete(workerId);
          this._sessionFlags?.delete(workerId);
        }
      }
      workers.forEach((worker, index) => {
        const activity = worker.activity ?? (worker.activeTaskIds?.length ? 'thinking' : 'idle');
        const text = activity === 'needs-input' ? '🛑' : activity === 'thinking' ? '🤔' : this._flagFor(worker.workerId);
        let actor = this._workerActors.get(worker.workerId);
        if (!actor) {
          actor = this._clickableLabel(text, () => this._focusWorker(actor.jarvisWorker));
          actor.add_style_class_name('jarvis-worker-status');
          this._workerActors.set(worker.workerId, actor);
          this._workersBox.add_child(actor);
        }
        actor.text = text;
        actor.tooltip_text = `${worker.windowName}\nWindow: ${this._presenceText(worker.presence)}\nJarvis: ${this._activityText(activity)}`;
        actor.jarvisWorker = worker;
        actor.remove_style_class_name('jarvis-worker-focused');
        actor.remove_style_class_name('jarvis-worker-active');
        actor.remove_style_class_name('jarvis-worker-background');
        actor.add_style_class_name(worker.presence?.focused
          ? 'jarvis-worker-focused'
          : worker.presence?.active ? 'jarvis-worker-active' : 'jarvis-worker-background');
        this._workersBox.set_child_at_index(actor, index);
      });
    } finally {
      this._workersRefreshInFlight = false;
    }
  }

  _presenceText(presence) {
    return presence?.focused ? 'focused' : presence?.active ? 'recently active' : 'background';
  }

  _activityText(activity) {
    return activity === 'needs-input' ? 'needs input' : activity === 'thinking' ? 'thinking' : 'idle';
  }

  _focusWorker(worker) {
    const names = [worker.windowName, ...(worker.workspaceRoots ?? []).map((root) => root.split('/').pop())]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim().toLocaleLowerCase());
    const candidates = global.get_window_actors()
      .map((actor) => actor.meta_window)
      .filter((candidate) => candidate?.get_wm_class()?.toLocaleLowerCase().includes('code'));
    const titleMatches = candidates.filter((candidate) => windowTitleMatches(candidate.get_title(), names));
    const pidMatches = worker.windowPid
      ? candidates.filter((candidate) => candidate.get_pid() === worker.windowPid)
      : [];
    const window = titleMatches.length === 1
      ? titleMatches[0]
      : pidMatches.length === 1 ? pidMatches[0] : null;
    if (window) {
      Main.activateWindow(window);
      return;
    }
    if (titleMatches.length > 1) {
      console.warn(`Jarvis system status: multiple VS Code windows match ${worker.windowName}`);
      return;
    }
    const workspaceRoot = worker.workspaceRoots?.[0];
    try {
      Gio.Subprocess.new(workspaceRoot ? ['code', '--reuse-window', workspaceRoot] : ['code'], Gio.SubprocessFlags.NONE);
    } catch (error) {
      console.error(`Jarvis system status: unable to focus ${worker.windowName}: ${error.message}`);
    }
  }

  _flagFor(workerId) {
    if (!this._sessionFlags) this._sessionFlags = new Map();
    if (!this._sessionFlags.has(workerId)) {
      const assigned = new Set(this._sessionFlags.values());
      const available = SESSION_FLAGS.find((flag) => !assigned.has(flag));
      this._sessionFlags.set(workerId, available ?? SESSION_FLAGS[this._sessionFlags.size % SESSION_FLAGS.length]);
    }
    return this._sessionFlags.get(workerId);
  }
}

function windowTitleMatches(title, names) {
  if (typeof title !== 'string' || !Array.isArray(names)) return false;
  const parts = title.split(' - ').map((part) => part.trim().toLocaleLowerCase());
  return names.some((name) => parts.includes(name));
}
