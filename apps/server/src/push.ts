import webPush, { type PushSubscription } from 'web-push';
import type { Store } from './database.js';

export class PushService {
  readonly publicKey: string;

  constructor(private readonly store: Store) {
    let publicKey = store.getSetting('vapid.publicKey');
    let privateKey = store.getSetting('vapid.privateKey');
    if (!publicKey || !privateKey) {
      const generated = webPush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      store.setSetting('vapid.publicKey', publicKey);
      store.setSetting('vapid.privateKey', privateKey);
    }
    this.publicKey = publicKey;
    webPush.setVapidDetails('mailto:jarvis@localhost', publicKey, privateKey);
  }

  subscribe(subscription: PushSubscription): void {
    if (!subscription.endpoint || !subscription.keys?.auth || !subscription.keys?.p256dh) {
      throw new Error('Invalid push subscription');
    }
    this.store.savePushSubscription(subscription);
  }

  async send(payload: { title: string; body: string; url: string }): Promise<void> {
    await Promise.allSettled(this.store.listPushSubscriptions().map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600 });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) this.store.deletePushSubscription(subscription.endpoint);
      }
    }));
  }
}
