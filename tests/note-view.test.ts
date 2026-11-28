import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { NoteViewStore } from "../src/note-view";

function localProfile(deviceName?: string) {
  const storage = new Map<string, unknown>();
  const sync = { deviceName };
  const app = {
    internalPlugins: { getEnabledPluginById: () => sync },
    loadLocalStorage: (key: string) => storage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => value === null ? storage.delete(key) : storage.set(key, value)
  } as unknown as App;
  return { app, storage, sync };
}

test("a device migrates its old zoom and seeds its initial layout only once", () => {
  const { app, storage } = localProfile("Office");
  storage.set("modern-draw-note-zoom:Lecture.md", 0.85);
  const store = new NoteViewStore(app);
  assert.equal(store.initializeLayout("Lecture.md", "left"), "left");
  store.saveLayout("Lecture.md", "center");
  const reopened = new NoteViewStore(app);
  assert.equal(reopened.initializeLayout("Lecture.md", "left"), "center");
  assert.deepEqual(reopened.load("Lecture.md"), { zoom: 0.85, layout: "center" });
  assert.equal(storage.has("modern-draw-note-zoom:Lecture.md"), false);
});

test("preferences saved before Sync supplies a name migrate locally and follow a note rename", () => {
  const { app, storage, sync } = localProfile();
  const store = new NoteViewStore(app);
  store.saveLayout("Lecture.md", "left");
  store.saveZoom("Lecture.md", 1.3);
  sync.deviceName = "iPad";
  store.move("Lecture.md", "Notes/Lecture.md");

  const reopened = new NoteViewStore(app);
  assert.deepEqual(reopened.load("Notes/Lecture.md"), { zoom: 1.3, layout: "left" });
  assert.deepEqual(reopened.load("Lecture.md"), {});
  assert.deepEqual([...storage.keys()], ['modern-draw-note-view:["iPad","Notes/Lecture.md"]']);
  sync.deviceName = "Desktop";
  assert.deepEqual(reopened.load("Notes/Lecture.md"), {});
});
