// Render a todo store as plain text.

export function formatItem(item) {
  return `[${item.done ? "x" : " "}] #${item.id} ${item.title}`;
}

export function formatList(store) {
  if (!store.items.length) return "(empty)";
  return store.items.map(formatItem).join("\n");
}
