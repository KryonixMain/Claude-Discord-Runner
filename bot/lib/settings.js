import { existsSync, readFileSync, writeFileSync } from "fs";
import { SETTINGS_FILE } from "./paths.js";
import { DEFAULT_SETTINGS } from "./plans.js";

export function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override ?? {})) {
    if (
      typeof override[key] === "object" &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

export function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) {
    writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return deepMerge(DEFAULT_SETTINGS, raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export function getSetting(...keys) {
  return keys.reduce((obj, k) => obj?.[k], loadSettings());
}
