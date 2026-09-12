import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the real polling logic without a running GNOME Shell or its GI imports.
const source = await readFile(new URL('./jarvis-system-status@jarvis/extension.js', import.meta.url), 'utf8');
let nextTimeoutId = 1;
const pendingTimeouts = new Map();
const GLib = {
  PRIORITY_DEFAULT: 0,
  SOURCE_CONTINUE: true,
  SOURCE_REMOVE: false,
  timeout_add_seconds(_priority, seconds, callback) {
    const id = nextTimeoutId++;
    pendingTimeouts.set(id, { seconds, callback });
    return id;
  },
  Source: { remove: (id) => pendingTimeouts.delete(id) },
};
const Soup = {
  Session: class {},
  Message: {
    new(_method, url) {
      return {
        url,
        status: 200,
        set_method(method) { this.method = method; },
        get_status() { return this.status; },
      };
    },
  },
};
const Gio = {
  Cancellable: {
    new: () => ({ cancel() { this.cancelled = true; } }),
  },
};
const Extension = runInNewContext(
  source.replace(/^import .*;\n/gm, '').replace('export default class', 'class') + '\nJarvisSystemStatusExtension;',
  {
    Extension: class {},
    GObject: { registerClass: (value) => value },
    PanelMenu: { Button: class {} },
    Clutter: { DesaturateEffect: class {} },
    Gio,
    GLib,
    Soup,
    TextDecoder,
    console,
  },
);

const repository = { id: 'repo', name: 'Project', path: '/tmp/project', defaultBranch: 'main' };
const worker = { workerId: 'worker', workspaceRoots: [repository.path], presence: { focused: true }, activity: 'thinking' };

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

class FakeSession {
  constructor(respond) {
    this._respond = respond;
    this.requests = [];
    this.aborted = false;
  }

  send_and_read_async(message) {
    const path = new URL(message.url).pathname.replace(/^\/api\//, '');
    this.requests.push(path);
    return Promise.resolve(this._respond(path)).then((value) => {
      const data = new TextEncoder().encode(JSON.stringify(value));
      return { get_data: () => data };
    });
  }

  abort() {
    this.aborted = true;
  }
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const extension = new Extension();
  const responses = new Map([
    ['repositories', [repository]],
    ['workers', [worker]],
    ['repositories/repo/status', { branch: 'feature/current', dirty: true, clean: false }],
  ]);
  const requests = [];
  const requestTimeouts = new Map();
  const tooltips = [];
  extension._session = {};
  extension._statusSession = {};
  extension._statusQueue = [];
  extension._activeStatusRequests = 0;
  extension._repositoryActors = new Map();
  extension._workerWindows = new Map();
  extension._workersBox = { add_child() {}, set_child_at_index() {} };
  extension._fetch = async (path, _method, timeoutSeconds) => {
    requests.push(path);
    requestTimeouts.set(path, timeoutSeconds);
    return responses.get(path) ?? null;
  };
  extension._clickableLabel = () => ({
    hover: false,
    add_style_class_name() {},
    remove_style_class_name() {},
    remove_effect_by_name() {},
    add_effect_with_name() {},
    destroy() { this.destroyed = true; },
  });
  extension._syncTooltip = (actor) => tooltips.push(actor.jarvisTooltipText);
  return { extension, responses, requests, requestTimeouts, tooltips };
}

function transportFixture(repositoryCount = 3) {
  pendingTimeouts.clear();
  const repositories = Array.from({ length: repositoryCount }, (_value, index) => ({
    id: `repo-${index + 1}`,
    name: `Project ${index + 1}`,
    path: `/tmp/project-${index + 1}`,
  }));
  const statusRequests = [];
  const respond = (path) => {
    if (path.endsWith('/status')) {
      const request = deferred();
      request.path = path;
      statusRequests.push(request);
      return request.promise;
    }
    if (path === 'repositories') return repositories;
    if (path === 'workers') return [];
    if (path === 'metrics') return { cpuPercent: 25, memoryUsedBytes: 1, memoryTotalBytes: 4 };
    throw new Error(`Unexpected request: ${path}`);
  };
  const generalSession = new FakeSession(respond);
  const statusSession = new FakeSession(respond);
  const extension = new Extension();
  extension._session = generalSession;
  extension._statusSession = statusSession;
  extension._statusQueue = [];
  extension._activeStatusRequests = 0;
  extension._repositoryActors = new Map();
  extension._workerWindows = new Map();
  extension._workersBox = { add_child() {}, set_child_at_index() {} };
  extension._clickableLabel = () => ({
    hover: false,
    add_style_class_name() {},
    remove_style_class_name() {},
    remove_effect_by_name() {},
    add_effect_with_name() {},
    destroy() { this.destroyed = true; },
  });
  extension._syncTooltip = () => {};
  return { extension, generalSession, repositories, statusRequests, statusSession };
}

test('shows the checked-out branch and dirty state alongside window context', async () => {
  const { extension, requests, requestTimeouts } = fixture();
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('repo').jarvisTooltipText,
    'Project\nBranch: feature/current\nGit: dirty\nWindow: focused\nJarvis: thinking');
  assert.ok(requests.includes('repositories/repo/status'));
  assert.equal(requestTimeouts.get('repositories/repo/status'), 35);
});

test('retains branch after worker closes and follows checkout changes without a worker', async () => {
  const { extension, responses, tooltips } = fixture();
  await extension._refreshWorkers();
  await flushAsyncWork();
  const actor = extension._repositoryActors.get('repo');
  actor.hover = true;
  responses.set('workers', []);
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(actor.jarvisTooltipText, 'Project\nBranch: feature/current\nGit: dirty\nWindow: closed');

  responses.set('repositories/repo/status', { branch: 'another-branch', dirty: false, clean: true });
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(actor.jarvisTooltipText, 'Project\nBranch: another-branch\nGit: clean\nWindow: closed');
  assert.equal(tooltips.at(-1), actor.jarvisTooltipText);
  assert.equal(actor.jarvisWorker, undefined);
});

test('reads status on a fresh extension with no Copilot sessions', async () => {
  const { extension, responses } = fixture();
  responses.set('workers', []);
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('repo').jarvisTooltipText,
    'Project\nBranch: feature/current\nGit: dirty\nWindow: closed');
});

test('marks failed reads as last known and clears the marker after recovery', async () => {
  const { extension, responses } = fixture();
  await extension._refreshWorkers();
  await flushAsyncWork();
  const actor = extension._repositoryActors.get('repo');
  responses.set('repositories/repo/status', null);
  responses.set('workers', []);
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(actor.jarvisTooltipText,
    'Project\nBranch: feature/current (last known)\nGit: dirty (last known)\nWindow: closed');
  responses.set('repositories/repo/status', { branch: 'main', dirty: false, clean: true });
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(actor.jarvisTooltipText, 'Project\nBranch: main\nGit: clean\nWindow: closed');
});

test('does not substitute the default branch or clean state for an unavailable checkout', async () => {
  const { extension, responses } = fixture();
  responses.set('repositories/repo/status', null);
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('repo').jarvisTooltipText,
    'Project\nBranch: unknown\nGit: unavailable\nWindow: focused\nJarvis: thinking');
});

test('distinguishes detached HEAD and untracked-only changes', async () => {
  const { extension, responses } = fixture();
  responses.set('repositories/repo/status', { branch: '(detached)', dirty: false, clean: false });
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('repo').jarvisTooltipText,
    'Project\nBranch: detached HEAD\nGit: clean (untracked files)\nWindow: focused\nJarvis: thinking');
});

test('a failed status request does not prevent other repositories from updating', async () => {
  const { extension, responses } = fixture();
  responses.set('repositories', [repository, { id: 'other', name: 'Other', path: '/tmp/other' }]);
  responses.set('repositories/repo/status', null);
  responses.set('repositories/other/status', { branch: 'develop', dirty: false, clean: true });
  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('other').jarvisTooltipText,
    'Other\nBranch: develop\nGit: clean\nWindow: closed');
});

test('reconciles worker and repository lists while one status remains pending', async () => {
  const { extension, responses } = fixture();
  const healthy = { id: 'healthy', name: 'Healthy', path: '/tmp/healthy' };
  const removed = { id: 'removed', name: 'Removed', path: '/tmp/removed' };
  const added = { id: 'added', name: 'Added', path: '/tmp/added' };
  responses.set('repositories', [repository, healthy, removed]);
  responses.set('repositories/healthy/status', { branch: 'stable', dirty: false, clean: true });
  responses.set('repositories/removed/status', { branch: 'main', dirty: false, clean: true });
  const pendingStatus = deferred();
  const fetch = extension._fetch;
  let pendingStatusRequests = 0;
  extension._fetch = (path, ...args) => {
    if (path === 'repositories/repo/status') {
      pendingStatusRequests++;
      return pendingStatus.promise;
    }
    return fetch(path, ...args);
  };

  const firstRefresh = extension._refreshWorkers();
  await flushAsyncWork();
  const actor = extension._repositoryActors.get('repo');
  assert.ok(actor);
  assert.equal(actor.jarvisStatusPending, true);
  assert.equal(actor.jarvisTooltipText,
    'Project\nBranch: unknown\nGit: unavailable\nWindow: focused\nJarvis: thinking');
  assert.equal(extension._repositoryActors.get('healthy').jarvisTooltipText,
    'Healthy\nBranch: stable\nGit: clean\nWindow: closed');
  const removedActor = extension._repositoryActors.get('removed');

  responses.set('repositories', [repository, healthy, added]);
  responses.set('workers', []);
  responses.set('repositories/healthy/status', { branch: 'feature/healthy', dirty: true, clean: false });
  responses.set('repositories/added/status', { branch: 'develop', dirty: false, clean: true });
  const secondRefresh = extension._refreshWorkers();
  await flushAsyncWork();

  assert.equal(pendingStatusRequests, 1);
  assert.equal(extension._repositoryActors.get('repo'), actor);
  assert.equal(actor.jarvisTooltipText, 'Project\nBranch: unknown\nGit: unavailable\nWindow: closed');
  assert.equal(extension._repositoryActors.get('healthy').jarvisTooltipText,
    'Healthy\nBranch: feature/healthy\nGit: dirty\nWindow: closed');
  assert.equal(extension._repositoryActors.get('added').jarvisTooltipText,
    'Added\nBranch: develop\nGit: clean\nWindow: closed');
  assert.equal(extension._repositoryActors.has('removed'), false);
  assert.equal(removedActor.destroyed, true);

  pendingStatus.resolve({ branch: 'slow-ready', dirty: false, clean: false });
  await Promise.all([firstRefresh, secondRefresh]);
  await flushAsyncWork();
  assert.equal(actor.jarvisStatusPending, false);
  assert.equal(actor.jarvisTooltipText,
    'Project\nBranch: slow-ready\nGit: clean (untracked files)\nWindow: closed');
});

test('removes deleted repositories and hides their hovered tooltip', async () => {
  const { extension, responses } = fixture();
  await extension._refreshWorkers();
  const actor = extension._repositoryActors.get('repo');
  actor.hover = true;
  let hidden = false;
  extension._tooltip = { hide() { hidden = true; } };
  responses.set('repositories', []);
  await extension._refreshWorkers();
  assert.equal(extension._repositoryActors.size, 0);
  assert.equal(actor.destroyed, true);
  assert.equal(hidden, true);
});

test('does not apply a pending status after removing and re-adding the same repository id', async () => {
  const { extension, responses } = fixture();
  const staleStatus = deferred();
  const fetch = extension._fetch;
  let statusRequests = 0;
  extension._fetch = (path, ...args) => {
    if (path === 'repositories/repo/status') {
      statusRequests++;
      if (statusRequests === 1) return staleStatus.promise;
      return Promise.resolve({ branch: 'fresh', dirty: false, clean: true });
    }
    return fetch(path, ...args);
  };

  const firstRefresh = extension._refreshWorkers();
  await flushAsyncWork();
  const removedActor = extension._repositoryActors.get('repo');
  assert.ok(removedActor);
  responses.set('repositories', []);
  await extension._refreshWorkers();
  responses.set('repositories', [repository]);
  await extension._refreshWorkers();
  await flushAsyncWork();
  const replacementActor = extension._repositoryActors.get('repo');
  assert.notEqual(replacementActor, removedActor);
  assert.equal(replacementActor.jarvisTooltipText,
    'Project\nBranch: fresh\nGit: clean\nWindow: focused\nJarvis: thinking');

  staleStatus.resolve({ branch: 'stale', dirty: true, clean: false });
  await firstRefresh;
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('repo'), replacementActor);
  assert.equal(replacementActor.jarvisTooltipText,
    'Project\nBranch: fresh\nGit: clean\nWindow: focused\nJarvis: thinking');
});

test('does not apply a pending status after disable and re-enable', async () => {
  const { extension } = fixture();
  const fetch = extension._fetch;
  const staleStatus = deferred();
  let statusRequests = 0;
  extension._fetch = (path, ...args) => {
    if (path === 'repositories/repo/status') {
      statusRequests++;
      if (statusRequests === 1) return staleStatus.promise;
      return Promise.resolve({ branch: 'fresh', dirty: false, clean: true });
    }
    return fetch(path, ...args);
  };

  const staleRefresh = extension._refreshWorkers();
  await flushAsyncWork();
  extension._session = {};
  extension._statusSession = {};
  extension._statusQueue = [];
  extension._activeStatusRequests = 0;
  extension._repositoryActors = new Map();
  extension._workersRefreshInFlight = false;
  await extension._refreshWorkers();
  await flushAsyncWork();
  const currentActor = extension._repositoryActors.get('repo');
  assert.equal(currentActor.jarvisTooltipText,
    'Project\nBranch: fresh\nGit: clean\nWindow: focused\nJarvis: thinking');

  staleStatus.resolve({ branch: 'stale', dirty: true, clean: false });
  await staleRefresh;
  await flushAsyncWork();
  assert.equal(extension._repositoryActors.get('repo'), currentActor);
  assert.equal(currentActor.jarvisTooltipText,
    'Project\nBranch: fresh\nGit: clean\nWindow: focused\nJarvis: thinking');
});

test('does not overlap list polls or clear a new session list guard', async () => {
  const { extension } = fixture();
  const fetch = extension._fetch;
  const pendingRepositories = deferred();
  let repositoryRequests = 0;
  let workerRequests = 0;
  extension._fetch = (path, ...args) => {
    if (path === 'repositories') {
      repositoryRequests++;
      return pendingRepositories.promise;
    }
    if (path === 'workers') workerRequests++;
    return fetch(path, ...args);
  };

  const refresh = extension._refreshWorkers();
  await Promise.resolve();
  await extension._refreshWorkers();
  assert.equal(repositoryRequests, 1);
  assert.equal(workerRequests, 1);
  extension._session = {};
  extension._workersRefreshInFlight = true;
  pendingRepositories.resolve([repository]);
  await refresh;
  assert.equal(extension._repositoryActors.size, 0);
  assert.equal(extension._workersRefreshInFlight, true);
});

test('isolates status transport and dispatches at most two FIFO without duplicate enqueues', async () => {
  const { extension, generalSession, repositories, statusRequests, statusSession } = transportFixture();
  await extension._refreshWorkers();
  await flushAsyncWork();

  assert.deepEqual(generalSession.requests, ['repositories', 'workers']);
  assert.deepEqual(statusSession.requests, [
    'repositories/repo-1/status',
    'repositories/repo-2/status',
  ]);
  assert.deepEqual([...pendingTimeouts.values()].map(({ seconds }) => seconds), [35, 35]);
  assert.ok(repositories.every(({ id }) => extension._repositoryActors.get(id).jarvisStatusPending));

  const metrics = await extension._fetch('metrics');
  assert.equal(metrics.cpuPercent, 25);
  assert.equal(generalSession.requests.at(-1), 'metrics');

  await extension._refreshWorkers();
  await flushAsyncWork();
  assert.equal(statusSession.requests.length, 2);
  assert.equal(statusRequests.length, 2);

  statusRequests[0].resolve({ branch: 'first', dirty: false, clean: true });
  await flushAsyncWork();
  assert.deepEqual(statusSession.requests, [
    'repositories/repo-1/status',
    'repositories/repo-2/status',
    'repositories/repo-3/status',
  ]);
  assert.equal(extension._activeStatusRequests, 2);
  assert.equal(pendingTimeouts.size, 2);

  statusRequests[1].resolve({ branch: 'second', dirty: false, clean: true });
  statusRequests[2].resolve({ branch: 'third', dirty: false, clean: true });
  await flushAsyncWork();
  assert.equal(extension._activeStatusRequests, 0);
  assert.equal(pendingTimeouts.size, 0);
});

test('skips a queued status when its repository actor is removed', async () => {
  const { extension, repositories, statusRequests, statusSession } = transportFixture();
  await extension._refreshWorkers();
  await flushAsyncWork();
  const queuedActor = extension._repositoryActors.get(repositories[2].id);
  extension._repositoryActors.delete(repositories[2].id);
  queuedActor.destroy();

  statusRequests[0].resolve({ branch: 'first', dirty: false, clean: true });
  await flushAsyncWork();
  assert.equal(statusSession.requests.length, 2);
  assert.equal(queuedActor.jarvisStatusPending, false);

  statusRequests[1].resolve({ branch: 'second', dirty: false, clean: true });
  await flushAsyncWork();
});

test('disable discards queued statuses and old completions cannot corrupt a new dispatcher', async () => {
  const { extension, repositories, statusRequests, statusSession } = transportFixture();
  await extension._refreshWorkers();
  await flushAsyncWork();
  const queuedActor = extension._repositoryActors.get(repositories[2].id);

  extension.disable();
  assert.equal(statusSession.aborted, true);
  assert.equal(queuedActor.jarvisStatusPending, false);

  const currentStatus = deferred();
  const currentGeneralSession = new FakeSession(() => null);
  const currentStatusSession = new FakeSession(() => currentStatus.promise);
  const currentRepository = { id: 'current', name: 'Current', path: '/tmp/current' };
  const currentActor = extension._clickableLabel();
  currentActor.jarvisRepository = currentRepository;
  currentActor.jarvisStatusPending = false;
  currentActor.jarvisStatusFailed = false;
  extension._session = currentGeneralSession;
  extension._statusSession = currentStatusSession;
  extension._statusQueue = [];
  extension._activeStatusRequests = 0;
  extension._repositoryActors = new Map([[currentRepository.id, currentActor]]);
  extension._workersBox = {};
  extension._workersRefreshInFlight = false;
  extension._refreshRepositoryStatus(currentActor);
  await flushAsyncWork();
  assert.equal(currentStatusSession.requests.length, 1);
  assert.equal(extension._activeStatusRequests, 1);

  statusRequests[0].resolve({ branch: 'stale', dirty: true, clean: false });
  await flushAsyncWork();
  assert.equal(extension._activeStatusRequests, 1);
  assert.equal(currentStatusSession.requests.length, 1);

  currentStatus.resolve({ branch: 'fresh', dirty: false, clean: true });
  await flushAsyncWork();
  assert.equal(extension._activeStatusRequests, 0);
  assert.equal(currentActor.jarvisRepositoryStatus.branch, 'fresh');
});
