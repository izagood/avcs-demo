import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, addItem, completeItem, pendingCount } from "../src/todo.js";
import { formatList } from "../src/format.js";

test("add and complete items", () => {
  const store = createStore();
  addItem(store, "buy milk");
  addItem(store, "write demo");
  assert.equal(pendingCount(store), 2);
  completeItem(store, 1);
  assert.equal(pendingCount(store), 1);
});

test("completing an unknown id throws", () => {
  const store = createStore();
  assert.throws(() => completeItem(store, 99));
});

test("formatList renders both states", () => {
  const store = createStore();
  addItem(store, "a");
  addItem(store, "b");
  completeItem(store, 1);
  assert.equal(formatList(store), "[x] #1 a\n[ ] #2 b");
});
