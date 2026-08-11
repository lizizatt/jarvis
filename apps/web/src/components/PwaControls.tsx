import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Bell, Compass, Download, Radio, Settings as SettingsIcon, X } from 'lucide-react';
import { api } from '../api';
import {
  announceMotionPermission,
  getMotionPermissionState,
  isMotionBackgroundEnabled,
  requestMotionPermission,
  setMotionBackgroundEnabled,
  type MotionPermissionState
} from '../motion';
import { SIGIL_FRAME_RATE_OPTIONS, getSigilFrameRate, setSigilFrameRate } from '../renderSettings';
import { FROST_BLUR_MAX, getFrostBlur, setFrostBlur } from '../frostSettings';

interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function decodeKey(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

function detectIosSafari() {
  const ua = navigator.userAgent;
  const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/i.test(ua);
  const standalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return iOS && webkit && !standalone;
}

export function PwaControls() {
  const [open, setOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [notifications, setNotifications] = useState<NotificationPermission>(() => typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  const [motionPermission, setMotionPermission] = useState<MotionPermissionState>(() => getMotionPermissionState());
  const [motionEnabled, setMotionEnabled] = useState(() => isMotionBackgroundEnabled());
  const [message, setMessage] = useState('');
  const [frameRate, setFrameRate] = useState(() => getSigilFrameRate());
  const [frostBlur, setFrostBlurState] = useState(() => getFrostBlur());
  const iosInstallHint = useMemo(() => typeof window !== 'undefined' && detectIosSafari(), []);

  useEffect(() => {
    const listener = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', listener);
    return () => window.removeEventListener('beforeinstallprompt', listener);
  }, []);

  async function install() {
    await installPrompt?.prompt();
    if ((await installPrompt?.userChoice)?.outcome === 'accepted') setInstallPrompt(undefined);
  }

  async function enablePush() {
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('Notifications are not supported on this browser');
      const permission = await Notification.requestPermission();
      setNotifications(permission);
      if (permission !== 'granted') return;
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await api.vapidKey();
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
      await api.subscribePush(subscription.toJSON());
      setMessage('Notifications enabled');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Could not enable notifications');
    }
  }

  async function toggleMotion() {
    if (motionEnabled) {
      setMotionEnabled(false);
      setMotionBackgroundEnabled(false);
      setMessage('Motion background disabled');
      return;
    }

    const permission = motionPermission === 'granted' ? 'granted' : await requestMotionPermission();
    setMotionPermission(permission);
    announceMotionPermission(permission);
    if (permission === 'granted') {
      setMotionEnabled(true);
      setMotionBackgroundEnabled(true);
      setMessage('Motion background enabled');
    }
    if (permission === 'denied') {
      setMotionEnabled(false);
      setMotionBackgroundEnabled(false);
      setMessage('Motion permission denied by browser');
    }
  }

  return <>
    <button className="icon-button" aria-label="Settings" onClick={() => setOpen(true)}><SettingsIcon /></button>
    {open && createPortal(<div className="modal-backdrop"><section className="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="device-title"><header><div><p className="eyebrow">This device</p><h2 id="device-title">Settings</h2></div><button className="icon-button" aria-label="Close" onClick={() => setOpen(false)}><X /></button></header>
      <div className="setting-row"><div><strong>Install Jarvis</strong><p>{iosInstallHint ? 'On iPhone/iPad: Share → Add to Home Screen.' : 'Keep it in your app launcher for quick access.'}</p></div><button className="button secondary" onClick={() => void install()} disabled={!installPrompt}><Download size={17} />{installPrompt ? 'Install' : 'Installed'}</button></div>
      <div className="setting-row"><div><strong>Work alerts</strong><p>Questions, task results, and PR updates.</p></div><button className="button secondary" onClick={() => void enablePush()} disabled={notifications === 'granted'}><Bell size={17} />{notifications === 'granted' ? 'Enabled' : 'Enable'}</button></div>
      <div className="setting-row"><div><strong>Motion background</strong><p>{motionPermission === 'unsupported' ? 'Not available in this browser.' : 'Allow motion sensors so the starfield follows device rotation.'}</p></div><button className="button secondary" onClick={() => void toggleMotion()} disabled={motionPermission === 'unsupported'}><Compass size={17} />{motionEnabled ? 'Disable' : 'Enable'}</button></div>
      <div className="setting-row"><div><strong>Animation frame rate</strong><p>Cap how often the digital window redraws. Lower saves battery.</p></div><label className="sr-only" htmlFor="frame-rate">Animation frame rate</label><select id="frame-rate" value={frameRate} onChange={(event) => { const fps = Number(event.currentTarget.value); setFrameRate(fps); setSigilFrameRate(fps); }}>{SIGIL_FRAME_RATE_OPTIONS.map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}</select></div>
      <div className="setting-row"><div><strong>Frosting</strong><p>Blur the digital window behind repository cards and chat entries.</p></div><div className="frost-control"><input type="range" id="frost-blur" aria-label="Frosting" min={0} max={FROST_BLUR_MAX} step={1} value={frostBlur} onChange={(event) => { const px = Number(event.currentTarget.value); setFrostBlurState(px); setFrostBlur(px); }} /><span>{frostBlur}px</span></div></div>
      <div className="setting-row"><div><strong>Tailnet access</strong><p>Expose a local port through Tailscale.</p></div><Link className="button secondary" to="/settings" onClick={() => setOpen(false)}><Radio size={17} />Open</Link></div>
      {message && <p className="notice">{message}</p>}
    </section></div>, document.body)}
  </>;
}
