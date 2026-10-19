// Self-healing helpers for the server. No dependencies, so they can be tested on their own.

// Stops hammering Gemini after repeated failures: after `threshold` failures in a row the breaker stays
// open for `cooldownMs`, and callers answer instantly instead of making people wait for a timeout.
function createBreaker({ threshold = 3, cooldownMs = 60000, now = Date.now } = {}) {
  let fails = 0, openUntil = 0;
  return {
    isOpen: () => now() < openUntil,
    success() { fails = 0; },
    failure() { fails += 1; if (fails >= threshold) { openUntil = now() + cooldownMs; fails = 0; } }
  };
}

// Runs `fn(models)`. If every model is reported gone (retired), asks `discover()` for the models Google offers
// today, switches to them, and retries once. Discovery runs at most once per `cooldownMs`.
function createModelHealer({ initialModels, isModelGone, discover, cooldownMs = 600000, now = Date.now, log = console.warn }) {
  let models = initialModels.slice();
  let lastDiscovery = -Infinity;
  return {
    get models() { return models.slice(); },
    async run(fn) {
      try { return await fn(models.slice()); }
      catch (e) {
        if (!isModelGone(e) || now() - lastDiscovery < cooldownMs) throw e;
        lastDiscovery = now();
        let found = [];
        try { found = await discover(); } catch (err) { /* keep the original error */ }
        if (!found.length) throw e;
        models = found.slice(0, 3);
        log('Gemini models replaced automatically: ' + models.join(', '));
        return fn(models.slice());
      }
    }
  };
}

module.exports = { createBreaker, createModelHealer };
