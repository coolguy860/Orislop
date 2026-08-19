(() => {
  "use strict";

  function createDecisionCache({ limit = 500 } = {}) {
    const decisions = new Map();
    const userOverrides = new Set();

    function get(key) {
      if (!key || userOverrides.has(key)) return null;
      const value = decisions.get(key) || null;
      if (value) {
        decisions.delete(key);
        decisions.set(key, value);
      }
      return value;
    }

    function set(key, value) {
      if (!key || userOverrides.has(key)) return value;
      decisions.delete(key);
      decisions.set(key, value);
      while (decisions.size > limit) decisions.delete(decisions.keys().next().value);
      return value;
    }

    function allow(key) {
      if (!key) return;
      userOverrides.add(key);
      decisions.delete(key);
    }

    function isAllowed(key) {
      return Boolean(key && userOverrides.has(key));
    }

    function clear() {
      decisions.clear();
    }

    return { allow, clear, get, isAllowed, set };
  }

  function createHistoryWriter({ readList, writeList, limit = 300 }) {
    const queues = new Map();

    function append(key, records, keyFor) {
      const additions = Array.isArray(records) ? records : [records];
      const previous = queues.get(key) || Promise.resolve();
      const operation = previous
        .catch(() => {})
        .then(async () => {
          const current = await readList(key);
          const seen = new Set();
          const merged = [];
          for (const record of [...additions, ...current]) {
            const recordKey = keyFor(record);
            if (!recordKey || seen.has(recordKey)) continue;
            seen.add(recordKey);
            merged.push(record);
            if (merged.length >= limit) break;
          }
          await writeList(key, merged);
          return merged;
        });
      queues.set(key, operation);
      const cleanup = () => {
        if (queues.get(key) === operation) queues.delete(key);
      };
      void operation.then(cleanup, cleanup);
      return operation;
    }

    async function flush() {
      await Promise.all(Array.from(queues.values()).map((operation) => operation.catch(() => {})));
    }

    return { append, flush };
  }

  globalThis.OrislopExtensionCore = Object.freeze({
    createDecisionCache,
    createHistoryWriter
  });
})();
