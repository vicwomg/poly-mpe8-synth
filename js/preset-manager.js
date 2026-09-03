/**
 * Preset Manager for POLY-MPE Synthesizer.
 * Supports:
 * - Built-in Factory Presets (marked with '*' to indicate uneditable).
 * - Custom User Presets (Save, Edit / Overwrite, Delete).
 * - Cross-platform persistent storage ready for Capacitor (Android/iOS) and Web.
 */

import { PRESETS as FACTORY_PRESETS } from './presets.js';

const STORAGE_KEY = 'poly_mpe_user_presets_v1';

export class PresetStorageAdapter {
  /**
   * Loads user presets from storage.
   * Compatible with Web localStorage and Capacitor WebView persistence.
   */
  static async loadUserPresets() {
    try {
      // 1. Capacitor Native Preferences plugin hook (if available in Capacitor build)
      if (typeof window !== 'undefined' && window.Capacitor?.Plugins?.Preferences) {
        const { value } = await window.Capacitor.Plugins.Preferences.get({ key: STORAGE_KEY });
        if (value) {
          return JSON.parse(value);
        }
      }

      // 2. Standard Web / WebView persistent storage
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }
      }
    } catch (err) {
      console.warn('PresetStorageAdapter: Error loading user presets:', err);
    }
    return [];
  }

  /**
   * Saves user presets to storage.
   */
  static async saveUserPresets(presets) {
    try {
      const json = JSON.stringify(presets);

      // 1. Save to localStorage (Web / WebView)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, json);
      }

      // 2. Mirror to Capacitor Preferences if running in native app
      if (typeof window !== 'undefined' && window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.set({ key: STORAGE_KEY, value: json });
      }
      return true;
    } catch (err) {
      console.error('PresetStorageAdapter: Error saving user presets:', err);
      return false;
    }
  }
}

export class PresetManager {
  constructor() {
    this.factoryPresets = FACTORY_PRESETS.map((p, idx) => ({
      id: `factory_${idx}`,
      name: p.name,
      displayName: p.name,
      isFactory: true,
      params: { ...p.params }
    }));
    this.userPresets = [];
    this.currentPresetId = this.factoryPresets[0].id;
    this.baselineParams = null;
    this.isModified = false;
  }

  /**
   * Asynchronously initializes and loads user presets from storage.
   */
  async init() {
    const loaded = await PresetStorageAdapter.loadUserPresets();
    this.userPresets = loaded.map(p => ({
      id: p.id || `user_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      name: p.name || 'Untitled Patch',
      displayName: p.name || 'Untitled Patch',
      isFactory: false,
      params: { ...p.params }
    }));
  }

  /**
   * Sets the baseline parameters against which modifications are compared.
   */
  setBaselinePreset(preset) {
    if (!preset) return;
    this.currentPresetId = preset.id;
    this.baselineParams = JSON.parse(JSON.stringify(preset.params));
    this.isModified = false;
  }

  /**
   * Compares current parameters against the baseline preset parameters.
   * Sets and returns isModified boolean.
   */
  checkModified(currentParams) {
    if (!this.baselineParams || !currentParams) {
      this.isModified = false;
      return false;
    }
    let modified = false;
    for (const key of Object.keys(this.baselineParams)) {
      const baseVal = this.baselineParams[key];
      const curVal = currentParams[key];
      if (curVal === undefined) continue;

      if (typeof baseVal === 'number') {
        if (Math.abs(baseVal - curVal) > 0.0001) {
          modified = true;
          break;
        }
      } else if (baseVal !== curVal) {
        modified = true;
        break;
      }
    }
    this.isModified = modified;
    return modified;
  }

  /**
   * Returns all presets structured into User and Factory lists.
   */
  getUserPresets() {
    return this.userPresets;
  }

  getFactoryPresets() {
    return this.factoryPresets;
  }

  getAllPresets() {
    return [...this.userPresets, ...this.factoryPresets];
  }

  getPresetById(id) {
    return this.getAllPresets().find(p => p.id === id) || this.factoryPresets[0];
  }

  /**
   * Saves a new user preset or overwrites an existing user preset.
   * @param {string} name - The preset name
   * @param {Object} params - Current synth parameters
   * @param {string|null} existingId - If provided and matches a user preset, overwrites it
   * @returns {Object} The saved preset object
   */
  async saveUserPreset(name, params, existingId = null) {
    const cleanName = (name || 'Custom Patch').trim().slice(0, 32);

    // If existingId is a user preset, overwrite it
    if (existingId && existingId.startsWith('user_')) {
      const idx = this.userPresets.findIndex(p => p.id === existingId);
      if (idx !== -1) {
        this.userPresets[idx] = {
          id: existingId,
          name: cleanName,
          displayName: cleanName,
          isFactory: false,
          params: JSON.parse(JSON.stringify(params)),
          updatedAt: Date.now()
        };
        await PresetStorageAdapter.saveUserPresets(this.userPresets);
        this.currentPresetId = existingId;
        return this.userPresets[idx];
      }
    }

    // Otherwise create a new user preset
    const newId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const newPreset = {
      id: newId,
      name: cleanName,
      displayName: cleanName,
      isFactory: false,
      params: JSON.parse(JSON.stringify(params)),
      createdAt: Date.now()
    };

    this.userPresets.unshift(newPreset); // Place newest at the top
    await PresetStorageAdapter.saveUserPresets(this.userPresets);
    this.currentPresetId = newId;
    return newPreset;
  }

  /**
   * Deletes a user preset by ID.
   * Factory presets are protected and cannot be deleted.
   * @returns {boolean} True if deleted
   */
  async deleteUserPreset(id) {
    if (!id || id.startsWith('factory_')) {
      console.warn('Cannot delete protected factory preset:', id);
      return false;
    }

    const initialLength = this.userPresets.length;
    this.userPresets = this.userPresets.filter(p => p.id !== id);

    if (this.userPresets.length !== initialLength) {
      await PresetStorageAdapter.saveUserPresets(this.userPresets);
      if (this.currentPresetId === id) {
        this.currentPresetId = this.factoryPresets[0].id;
      }
      return true;
    }
    return false;
  }

  /**
   * Export all user presets as a JSON string for cross-device sharing or backup.
   */
  exportToJson() {
    return JSON.stringify(this.userPresets, null, 2);
  }

  /**
   * Import user presets from a JSON string.
   */
  async importFromJson(jsonString) {
    try {
      const imported = JSON.parse(jsonString);
      if (Array.isArray(imported)) {
        for (const item of imported) {
          if (item && item.name && item.params) {
            await this.saveUserPreset(item.name, item.params);
          }
        }
        return true;
      }
    } catch (e) {
      console.error('Failed to import presets:', e);
    }
    return false;
  }
}
