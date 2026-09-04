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
const REPOSITORY_HEARTS = [
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '🩷', '🩵', '🩶',
  '💖', '💗', '💓', '💞', '💕', '💘', '💝', '💟', '❤️‍🔥', '❤️‍🩹',
];
const WINDOW_BRIDGE_BUS = 'org.gnome.Shell.Extensions.JarvisSystemStatus';
const WINDOW_BRIDGE_PATH = '/org/gnome/Shell/Extensions/JarvisSystemStatus';
const WINDOW_BRIDGE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.JarvisSystemStatus">
    <method name="RegisterWorker">
      <arg type="s" name="workerId" direction="in"/>
      <arg type="b" name="focused" direction="in"/>
    </method>
  </interface>
</node>`;

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
    this._dashboard = this._clickableLabel('🏳️‍⚧️', () => this._openUrl(DASHBOARD_URL));
    this._dashboard.jarvisTooltipText = 'Open Jarvis';
    this._cpu = this._clickableLabel('CPU --%', () => this._launchHtop());
    this._memory = this._clickableLabel('RAM --%', () => this._launchHtop());
    this._creditText = 'CR --';
    this._credits = this._clickableLabel(this._creditText, () => this._openUrl(DASHBOARD_URL));
    this._workersBox = new St.BoxLayout();
    this._repositoryActors = new Map();
    this._workerWindows = new Map();
    this._workersRefreshInFlight = false;
    this._tooltip = new St.Label({ style_class: 'jarvis-tooltip', visible: false });
    Main.layoutManager.addTopChrome(this._tooltip, { affectsInputRegion: false });
    const bridge = Gio.DBusExportedObject.wrapJSObject(WINDOW_BRIDGE_XML, this);
    this._bridge = bridge;
    this._bridgeBusOwner = Gio.bus_own_name(
      Gio.BusType.SESSION,
      WINDOW_BRIDGE_BUS,
      Gio.BusNameOwnerFlags.NONE,
      connection => { if (this._bridge === bridge) bridge.export(connection, WINDOW_BRIDGE_PATH); },
      null,
      () => { if (this._bridge === bridge) bridge.unexport(); },
    );
    this._box.add_child(this._dashboard);
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
    this._tooltip?.destroy();
    this._tooltip = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._box = null;
    this._dashboard = null;
    this._cpu = null;
    this._memory = null;
    this._credits = null;
    this._workersBox = null;
    this._repositoryActors = null;
    this._workerWindows = null;
    this._workersRefreshInFlight = false;
    const bridge = this._bridge;
    this._bridge = null;
    if (this._bridgeBusOwner) Gio.bus_unown_name(this._bridgeBusOwner);
    this._bridgeBusOwner = null;
    bridge?.unexport();
  }

  RegisterWorker(workerId, focused) {
    if (typeof workerId !== 'string' || !focused || !this._workerWindows) return;
    const window = global.display.get_focus_window();
    if (isCodeWindow(window)) this._workerWindows.set(workerId, window);
  }

  _clickableLabel(text, activate) {
    const label = new St.Label({ text, y_align: Clutter.ActorAlign.CENTER, reactive: true, track_hover: true });
    label.add_style_class_name('jarvis-status-item');
    label.connect('notify::hover', () => this._syncTooltip(label));
    label.connect('button-press-event', (_actor, event) => {
      if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
      activate();
      return Clutter.EVENT_STOP;
    });
    return label;
  }

  _syncTooltip(actor) {
    if (!this._tooltip) return;
    if (!actor.hover || !actor.jarvisTooltipText) {
      this._tooltip.hide();
      return;
    }
    this._tooltip.text = actor.jarvisTooltipText;
    this._tooltip.show();
    const [stageX, stageY] = actor.get_transformed_position();
    const [, actorHeight] = actor.get_transformed_size();
    const tooltipWidth = this._tooltip.get_width();
    const tooltipHeight = this._tooltip.get_height();
    const x = Math.clamp(stageX + (actor.width - tooltipWidth) / 2, 0, global.stage.width - tooltipWidth);
    const y = Math.min(stageY + actorHeight + 6, global.stage.height - tooltipHeight);
    this._tooltip.set_position(Math.floor(x), Math.floor(y));
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

  async _fetch(path, method = 'GET') {
    const session = this._session;
    if (!session) return null;
    const message = Soup.Message.new('GET', `${DASHBOARD_URL}api/${path}`);
    message.set_method(method);
    const cancellable = Gio.Cancellable.new();
    let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
      cancellable.cancel();
      timeout = 0;
      return GLib.SOURCE_REMOVE;
    });
    try {
      const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
      if (message.get_status() < 200 || message.get_status() >= 300) throw new Error(`HTTP ${message.get_status()}`);
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
      const [repositories, workers] = await Promise.all([
        this._fetch('repositories'),
        this._fetch('workers'),
      ]);
      if (!repositories || !workers || !this._workersBox) return;
      const currentWorkerIds = new Set(workers.map((worker) => worker.workerId));
      for (const workerId of this._workerWindows.keys()) {
        if (!currentWorkerIds.has(workerId)) this._workerWindows.delete(workerId);
      }
      const currentRepositoryIds = new Set(repositories.map((repository) => repository.id));
      for (const [repositoryId, actor] of this._repositoryActors) {
        if (!currentRepositoryIds.has(repositoryId)) {
          actor.destroy();
          this._repositoryActors.delete(repositoryId);
        }
      }
      repositories.forEach((repository, index) => {
        const worker = workers.find((candidate) => candidate.workspaceRoots?.includes(repository.path));
        const activity = worker?.activity ?? (worker?.activeTaskIds?.length ? 'thinking' : 'idle');
        const text = REPOSITORY_HEARTS[index % REPOSITORY_HEARTS.length];
        let actor = this._repositoryActors.get(repository.id);
        if (!actor) {
          actor = this._clickableLabel(text, () => this._activateRepository(actor.jarvisRepository, actor.jarvisWorker));
          actor.add_style_class_name('jarvis-worker-status');
          this._repositoryActors.set(repository.id, actor);
          this._workersBox.add_child(actor);
        }
        actor.text = text;
        actor.jarvisTooltipText = worker
          ? `${repository.name}\nWindow: ${this._presenceText(worker.presence)}\nJarvis: ${this._activityText(activity)}`
          : `${repository.name}\nWindow: closed`;
        actor.jarvisRepository = repository;
        actor.jarvisWorker = worker;
        actor.remove_style_class_name('jarvis-worker-focused');
        actor.remove_style_class_name('jarvis-worker-active');
        actor.remove_style_class_name('jarvis-worker-background');
        actor.remove_style_class_name('jarvis-worker-closed');
        actor.remove_effect_by_name('jarvis-worker-closed');
        actor.add_style_class_name(worker?.presence?.focused
          ? 'jarvis-worker-focused'
          : worker?.presence?.active ? 'jarvis-worker-active' : 'jarvis-worker-background');
        if (!worker) {
          actor.add_style_class_name('jarvis-worker-closed');
          actor.add_effect_with_name('jarvis-worker-closed', new Clutter.DesaturateEffect({ factor: 1.0 }));
        }
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

  _activateRepository(repository, worker) {
    if (worker && this._focusWorker(worker)) return;
    try {
      Gio.Subprocess.new(['code', repository.path], Gio.SubprocessFlags.NONE);
    } catch (error) {
      console.error(`Jarvis system status: unable to open Copilot for ${repository.name}: ${error.message}`);
    }
  }

  _focusWorker(worker) {
    const registeredWindow = this._workerWindows.get(worker.workerId);
    if (registeredWindow?.get_compositor_private()) {
      Main.activateWindow(registeredWindow);
      return true;
    }
    this._workerWindows.delete(worker.workerId);
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
      return true;
    }
    if (titleMatches.length > 1) {
      console.warn(`Jarvis system status: multiple VS Code windows match ${worker.windowName}`);
      return false;
    }
    console.warn(`Jarvis system status: no unambiguous window found for ${worker.windowName}`);
    return false;
  }

}

function windowTitleMatches(title, names) {
  if (typeof title !== 'string' || !Array.isArray(names)) return false;
  const parts = title.split(' - ').map((part) => part.trim().toLocaleLowerCase());
  return names.some((name) => parts.includes(name));
}

function isCodeWindow(window) {
  return window?.get_wm_class()?.toLocaleLowerCase().includes('code');
}
