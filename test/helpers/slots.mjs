// Contract fixture for the public SlotRegistry inspection/lifecycle faces.
export const CHAT_MODULE = '@deepseek-ai/dsh-client-ui-chat';
export const IMAGE_MODULE = '@deepseek-ai/dsh-client-ui-attachment';
export const CHAT_SLOT = 'conversation.chat.node';

export function AssistantNodeView() { return null; }
export function DefaultReasoningBody() { return null; }
export function MessageImages() { return null; }

export function makeSlots() {
  const entries = new Map();
  const subscriptions = new Map();
  const errorListeners = new Set();
  const retired = new Set();
  const factories = new Map();
  const registrations = [];
  let pending = new Set();
  function changed(key) {
    const idle = pending.size === 0;
    pending.add(key);
    if (idle) queueMicrotask(() => {
      const keys = pending;
      pending = new Set();
      for (const key of keys) for (const fn of [...(subscriptions.get(key) ?? [])]) fn();
    });
  }
  const slots = {
    inject(_key, callback) { return callback(); },
    register(options, component) {
      const { name, key, id, priority, ...metadata } = options;
      const entry = { component, options: { key, id, priority }, ...metadata };
      const list = entries.get(name) ?? [];
      if (list.some((row) => row.options.key === key && row.options.id === id
        && (row.options.priority ?? 0) === (priority ?? 0))) throw new Error('duplicate priority');
      list.push(entry);
      list.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
      entries.set(name, list);
      const registration = { options, component, entry };
      registrations.push(registration);
      changed(name);
      return () => {
        if (!list.includes(entry)) return;
        list.splice(list.indexOf(entry), 1);
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
        changed(name);
      };
    },
    entries: (key) => entries.get(key) ?? [],
    entriesOfSlot(key) {
      const seen = new Set();
      return this.entries(key).filter((row) => {
        const cell = row.options.key ?? row.options.id ?? '';
        if (retired.has(row) || seen.has(cell)) return false;
        seen.add(cell);
        return true;
      });
    },
    snapshot: (root) => factories.has(root) ? [factories.get(root)] : [],
    subscribe(key, fn) {
      if (!subscriptions.has(key)) subscriptions.set(key, new Set());
      subscriptions.get(key).add(fn);
      return () => subscriptions.get(key).delete(fn);
    },
    onEntryError(fn) { errorListeners.add(fn); return () => errorListeners.delete(fn); },
    reportEntryError(key, entry) {
      retired.add(entry);
      changed(key);
      for (const fn of [...errorListeners]) fn(key, entry, new Error('fixture crash'), { abdicated: true });
    },
  };
  const disposeOfficial = slots.register({
    name: CHAT_SLOT, key: 'assistant-step', locale: 'chat', registrant: CHAT_MODULE,
    children: {
      'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
      'conversation.chat.message.images': { kind: 'single', scope: 'session' },
    },
    inject: () => ({ hooks: { presentation: { getSnapshot: () => ({}), subscribe: () => () => {} } } }),
  }, AssistantNodeView);
  slots.register({ name: 'conversation.chat.reasoning.body', priority: 100, registrant: CHAT_MODULE }, DefaultReasoningBody);
  slots.register({ name: 'conversation.chat.message.images', priority: 100, registrant: IMAGE_MODULE }, MessageImages);
  for (const [name, registrant] of [['conversation.chat.reasoning.content', CHAT_MODULE], ['conversation.images.content', IMAGE_MODULE]]) {
    factories.set(`factory:${name}`, { type: 'factory', name, scope: 'root', registrant });
  }
  const official = slots.entries(CHAT_SLOT)[0];
  // The public registration list below tracks only contributions made by tests/plugin.
  registrations.length = 0;
  return { slots, registrations, factories, official, disposeOfficial,
    subscriberCount: () => [...subscriptions.values()].reduce((sum, set) => sum + set.size, 0) + errorListeners.size };
}
