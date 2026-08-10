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

function percent(used, total) {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

const JarvisIndicator = GObject.registerClass(
class JarvisIndicator extends PanelMenu.Button {
  _init() {
    super._init(0.0, 'Jarvis system status', false);
  }
});

export default class JarvisSystemStatusExtension extends Extension {
  enable() {
    this._session = new Soup.Session();
    this._indicator = new JarvisIndicator();
    this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
    this._cpu = new St.Label({ text: 'CPU --%', y_align: Clutter.ActorAlign.CENTER });
    this._memory = new St.Label({ text: 'RAM --%', y_align: Clutter.ActorAlign.CENTER });
    this._credits = new St.Label({ text: 'CR --', y_align: Clutter.ActorAlign.CENTER });
    this._box.add_child(this._cpu);
    this._box.add_child(new St.Label({ text: '  ', y_align: Clutter.ActorAlign.CENTER }));
    this._box.add_child(this._memory);
    this._box.add_child(new St.Label({ text: '  ', y_align: Clutter.ActorAlign.CENTER }));
    this._box.add_child(this._credits);
    this._indicator.add_child(this._box);
    this._indicator.connect('button-press-event', (_actor, event) => {
      if (event.get_button() === Clutter.BUTTON_PRIMARY) {
        Gio.AppInfo.launch_default_for_uri(DASHBOARD_URL, null);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    this._refreshMetrics();
    this._refreshCredits();
    this._metricsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
      this._refreshMetrics();
      return GLib.SOURCE_CONTINUE;
    });
    this._creditsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CREDIT_POLL_INTERVAL_SECONDS, () => {
      this._refreshCredits();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    if (this._metricsTimer) GLib.Source.remove(this._metricsTimer);
    if (this._creditsTimer) GLib.Source.remove(this._creditsTimer);
    this._metricsTimer = null;
    this._creditsTimer = null;
    this._session?.abort();
    this._session = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._box = null;
    this._cpu = null;
    this._memory = null;
    this._credits = null;
  }

  async _fetch(path) {
    const message = Soup.Message.new('GET', `${DASHBOARD_URL}api/${path}`);
    try {
      const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
      if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
      return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    } catch (error) {
      console.debug(`Jarvis system status: ${error.message}`);
      return null;
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
    if (this._indicator) this._credits.text = credits ? `CR ${credits.creditsUsed.toLocaleString()}` : 'CR --';
  }
}
