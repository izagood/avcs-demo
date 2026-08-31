// A deliberately small todo store — the demo subject, not the point.
// Two agents will edit this file concurrently; AVCS decides what happens.

export function createStore() {
  return { items: [], nextId: 1 };
}

export function addItem(store, title) {
  const item = { id: store.nextId, title, done: false };
  store.items.push(item);
  store.nextId += 1;
  return item;
}

export function completeItem(store, id) {
  const item = store.items.find((it) => it.id === id);
  if (!item) throw new Error(`no item ${id}`);
  item.done = true;
  return item;
}

export function pendingCount(store) {
  return store.items.filter((it) => !it.done).length;
}
