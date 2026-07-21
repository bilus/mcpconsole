const UNSUPPORTED_KEYWORDS = [
  "oneOf", "anyOf", "allOf", "not", "$ref", "$dynamicRef", "if", "then",
  "else", "patternProperties", "dependentSchemas", "dependentRequired",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems", "prefixItems",
];

export function isSchemaObject(s) {
  return s != null && typeof s === "object" && !Array.isArray(s);
}

// Recognize "this tool takes no arguments" schemas: absent schema, or a plain
// object schema without properties.
export function isEmptyObjectSchema(s) {
  if (s == null) return true;
  if (!isSchemaObject(s)) return false;
  if (UNSUPPORTED_KEYWORDS.some((k) => k in s)) return false;
  if (s.type !== undefined && s.type !== "object") return false;
  if (isSchemaObject(s.additionalProperties)) return false;
  return !s.properties || Object.keys(s.properties).length === 0;
}

// JSON-editor pre-fill.
export function skeleton(schema) {
  if (!isSchemaObject(schema)) return {};
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out = {};
      for (const [name, prop] of Object.entries(schema.properties || {})) {
        out[name] = skeleton(prop);
      }
      return out;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return schema.properties ? skeleton({ ...schema, type: "object" }) : null;
  }
}

export function jsonSeed(schema) {
  if (isEmptyObjectSchema(schema)) return {};
  const seed = skeleton(schema);
  return isSchemaObject(seed) ? seed : {};
}

const TOKEN_RE =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function tokenizeJson(value) {
  let json;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  if (json === undefined) json = "undefined";
  const tokens = [];
  let last = 0;
  for (const m of json.matchAll(TOKEN_RE)) {
    if (m.index > last) tokens.push({ cls: null, text: json.slice(last, m.index) });
    const t = m[0];
    let cls = "tok-num";
    if (t.startsWith('"')) cls = t.endsWith(":") ? "tok-key" : "tok-str";
    else if (t === "true" || t === "false") cls = "tok-bool";
    else if (t === "null") cls = "tok-null";
    tokens.push({ cls, text: t });
    last = m.index + t.length;
  }
  if (last < json.length) tokens.push({ cls: null, text: json.slice(last) });
  return tokens;
}
