const clone = value => value === undefined ? null : structuredClone(value);
export class MemoryDB {
  constructor(initial = {}) { this.data = clone(initial); this.queue = Promise.resolve(); }
  ref(path = '') {
    const parts = path.split('/').filter(Boolean); const db = this;
    const getValue = () => parts.reduce((value, part) => value?.[part], db.data);
    const setValue = value => {
      if (!parts.length) { db.data = clone(value) || {}; return; }
      let parent = db.data;
      for (const part of parts.slice(0, -1)) { parent[part] ||= {}; parent = parent[part]; }
      if (value === null) delete parent[parts.at(-1)]; else parent[parts.at(-1)] = clone(value);
    };
    const snapshot = value => ({ val: () => clone(value), exists: () => value !== undefined && value !== null });
    return {
      get: async () => snapshot(getValue()),
      set: async value => { setValue(value); },
      remove: async () => { setValue(null); },
      update: async values => { for (const [key, value] of Object.entries(values)) await db.ref(path + '/' + key).set(value); },
      transaction: async update => {
        const run = db.queue.then(() => { const next = update(clone(getValue())); if (next === undefined) return { committed: false, snapshot: snapshot(getValue()) }; setValue(next); return { committed: true, snapshot: snapshot(getValue()) }; });
        db.queue = run.catch(() => {}); return run;
      }
    };
  }
}
