/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ revision: string | null; url: string }> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('push', (event) => {
  const payload = event.data?.json() as { title?: string; body?: string; url?: string; repositoryId?: string; taskId?: string } | undefined;
  const url = payload?.url ?? (payload?.repositoryId ? `/repositories/${payload.repositoryId}${payload.taskId ? `?task=${payload.taskId}` : ''}` : '/');
  event.waitUntil(self.registration.showNotification(payload?.title ?? 'Jarvis update', {
    body: payload?.body ?? 'Developer activity needs your attention.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url },
    tag: payload?.taskId ? `task-${payload.taskId}` : 'jarvis-update'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(String(event.notification.data?.url ?? '/'), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows[0];
    if (client) { await client.navigate(url); await client.focus(); }
    else await self.clients.openWindow(url);
  })());
});
