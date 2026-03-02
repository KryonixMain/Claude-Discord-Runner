import { CLAUDE_PLANS } from "./plans.js";

const SCHEMA = {
  bot: {
    _type: "object",
    token:      { _type: "string" },
    clientId:   { _type: "string" },
    channelId:  { _type: "string" },
    guildId:    { _type: "string", _optional: true },
    webhookUrl: { _type: "string", _optional: true },
    locale:     { _type: "string", _optional: true },
    webhookUrls: {
      _type: "object",
      _optional: true,
      default:  { _type: "string", _optional: true },
      security: { _type: "string", _optional: true },
      progress: { _type: "string", _optional: true },
    },
  },
  runner: {
    _type: "object",
    defaultModel:     { _type: "string" },
    maxTurns:         { _type: "number", _min: 1, _max: 1000 },
    pauseMinutes:     { _type: "number", _min: 0, _max: 1440 },
    autoSecurityFix:  { _type: "boolean" },
    archiveOnComplete:{ _type: "boolean" },
    claudePlan:       { _type: "string", _enum: Object.keys(CLAUDE_PLANS) },
    workDir:          { _type: "string", _optional: true },
  },
  sessions: {
    _type: "object",
    count: { _type: "number", _min: 1, _max: 50 },
  },
  logging: {
    _type: "object",
    keepLogs: { _type: "number", _min: 1, _max: 100 },
  },
  dashboard: {
    _type: "object",
    port: { _type: "number", _min: 1, _max: 65535 },
  },
};

function validateField(value, schema, path) {
  const errors = [];
  const warnings = [];

  if (value === undefined || value === null || value === "") {
    if (schema._optional) return { errors, warnings };
    // Empty string is ok for optional string fields at top level
    if (schema._type === "string") return { errors, warnings };
    errors.push(`${path}: required field is missing`);
    return { errors, warnings };
  }

  if (schema._type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object, got ${typeof value}`);
      return { errors, warnings };
    }
    // Validate known subfields
    for (const [key, subSchema] of Object.entries(schema)) {
      if (key.startsWith("_")) continue;
      const result = validateField(value[key], subSchema, `${path}.${key}`);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
    // Warn about unknown keys
    for (const key of Object.keys(value)) {
      if (!schema[key] && !key.startsWith("_")) {
        warnings.push(`${path}.${key}: unknown setting key`);
      }
    }
    return { errors, warnings };
  }

  if (schema._type === "string" && typeof value !== "string") {
    errors.push(`${path}: expected string, got ${typeof value}`);
    return { errors, warnings };
  }
  if (schema._type === "number") {
    if (typeof value !== "number") {
      errors.push(`${path}: expected number, got ${typeof value}`);
      return { errors, warnings };
    }
    if (schema._min !== undefined && value < schema._min) {
      errors.push(`${path}: value ${value} below minimum ${schema._min}`);
    }
    if (schema._max !== undefined && value > schema._max) {
      errors.push(`${path}: value ${value} above maximum ${schema._max}`);
    }
  }
  if (schema._type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: expected boolean, got ${typeof value}`);
  }
  if (schema._enum && !schema._enum.includes(value)) {
    errors.push(`${path}: invalid value "${value}" — expected one of: ${schema._enum.join(", ")}`);
  }

  // Validate webhook URLs format
  if (schema._type === "string" && value && path.toLowerCase().includes("webhook") && value.length > 0) {
    if (!value.startsWith("http://") && !value.startsWith("https://")) {
      warnings.push(`${path}: webhook URL should start with http:// or https://`);
    }
  }

  return { errors, warnings };
}

export function validateConfig(settings) {
  const errors = [];
  const warnings = [];

  if (!settings || typeof settings !== "object") {
    return { valid: false, errors: ["Settings file is not a valid JSON object"], warnings: [] };
  }

  for (const [section, sectionSchema] of Object.entries(SCHEMA)) {
    const result = validateField(settings[section], sectionSchema, section);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // Warn about top-level unknown keys
  for (const key of Object.keys(settings)) {
    if (!SCHEMA[key]) {
      warnings.push(`${key}: unknown top-level settings section`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
