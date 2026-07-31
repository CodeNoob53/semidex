// Semidex Lite settings service — wraps the real SettingsService
// (service.js) so a Lite deployment's Settings API exposes ONLY the
// LITE_SETTINGS_KEYS allow-list (lite-policy.js): getAll() returns just
// that subset, get()/getActiveValue() on any other key behave as if the
// key doesn't exist (not_available_in_lite, distinct from the real
// service's own unknown_key so a caller can tell "this key exists in full
// Semidex but is out of scope for Lite" apart from "this key was never a
// real setting"), and setMany() rejects any non-Lite key in the SAME
// all-or-nothing pass the real service already uses for validation
// (never partially applies a batch that mixes an allowed and a
// disallowed key).
//
// This module never talks to settings.json/process.env itself — it holds
// no state of its own beyond the wrapped instance, so it can never write a
// hidden non-Lite field into settings.json: every write still goes through
// the real service's own validate()/writeSettingsFileAtomic() path
// unchanged, just pre-filtered by key.
import { LITE_SETTINGS_KEY_SET } from './lite-policy.js';

function notAvailableInLite(key) {
  const err = new Error(`Setting "${key}" is not available in Semidex Lite.`);
  err.code = 'not_available_in_lite';
  return err;
}

/**
 * @param {ReturnType<typeof import('./service.js').createSettingsService>} realService
 */
export function createLiteSettingsService(realService) {
  return {
    getAll() {
      return realService.getAll().filter((entry) => LITE_SETTINGS_KEY_SET.has(entry.key));
    },

    get(key) {
      if (!LITE_SETTINGS_KEY_SET.has(key)) return null;
      return realService.get(key);
    },

    getActiveValue(key) {
      if (!LITE_SETTINGS_KEY_SET.has(key)) throw notAvailableInLite(key);
      return realService.getActiveValue(key);
    },

    refreshIfChanged() {
      return realService.refreshIfChanged();
    },

    async setMany(rawChanges) {
      const disallowed = Object.keys(rawChanges).filter((key) => !LITE_SETTINGS_KEY_SET.has(key));
      if (disallowed.length > 0) throw notAvailableInLite(disallowed[0]);
      return realService.setMany(rawChanges);
    },
  };
}
