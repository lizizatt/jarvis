import { useEffect, useState } from 'react';
import { Bell, Download, X } from 'lucide-react';
import { api } from '../api';

interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function decodeKey(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

export function PwaControls() {
  const [open, setOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [notifications, setNotifications] = useState<NotificationPermission>(() => typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const listener = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', listener);
    return () => window.removeEventListener('beforeinstallprompt', listener);
  }, []);
  async function install() { await installPrompt?.prompt(); if ((await installPrompt?.userChoice)?.outcome === 'accepted') setInstallPrompt(undefined); }
  async function enablePush() {
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('Notifications are not supported on this browser');
      const permission = await Notification.requestPermission(); setNotifications(permission);
      if (permission !== 'granted') return;
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await api.vapidKey();
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
      await api.subscribePush(subscription.toJSON()); setMessage('Notifications enabled');
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not enable notifications'); }
  }
  return <><button className="icon-button" aria-label="App and notification settings" onClick={() => setOpen(true)}><Bell /></button>{open && <div className="modal-backdrop"><section className="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="device-title"><header><div><p className="eyebrow">This device</p><h2 id="device-title">App settings</h2></div><button className="icon-button" aria-label="Close" onClick={() => setOpen(false)}><X /></button></header><div className="setting-row"><div><strong>Install Jarvis</strong><p>Keep it in your app launcher for quick access.</p></div><button className="button secondary" onClick={() => void install()} disabled={!installPrompt}><Download size={17} />{installPrompt ? 'Install' : 'Installed'}</button></div><div className="setting-row"><div><strong>Work alerts</strong><p>Questions, task results, and PR updates.</p></div><button className="button secondary" onClick={() => void enablePush()} disabled={notifications === 'granted'}><Bell size={17} />{notifications === 'granted' ? 'Enabled' : 'Enable'}</button></div>{message && <p className="notice">{message}</p>}</section></div>}</>;
}
