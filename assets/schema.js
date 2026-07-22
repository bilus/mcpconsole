export const MAX_DEPTH = 4;

const UNSUPPORTED_KEYWORDS = [
  "oneOf", "anyOf", "allOf", "not", "$ref", "$dynamicRef", "if", "then",
  "else", "patternProperties", "dependentSchemas", "dependentRequired",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems", "prefixItems",
];
const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

export function isSchemaObject(s) {
  return s != null && typeof s === "object" && !Array.isArray(s);
}

function isScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
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

// Report whether the form renderer can build controls for the schema or fall
// back to the JSON editor.
export function isRenderable(schema, depth = 0) {
  if (!isSchemaObject(schema)) return false;
  if (depth > MAX_DEPTH) return false;
  if (UNSUPPORTED_KEYWORDS.some((k) => k in schema)) return false;
  if (schema.enum !== undefined) {
    return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(isScalar);
  }
  if (schema.const !== undefined) return isScalar(schema.const);
  const type = schema.type;
  if (type === undefined || Array.isArray(type)) return false;
  switch (type) {
    case "object": {
      if (depth > 0) return false;
      const props = schema.properties;
      if (!isSchemaObject(props) || Object.keys(props).length === 0) return false;
      if (isSchemaObject(schema.additionalProperties)) return false;
      return Object.values(props).every((p) => isRenderable(p, depth + 1));
    }
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return true;
    default:
      return false;
  }
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

export function enumOptions(prop) {
  if (prop.const !== undefined) return [prop.const];
  return prop.enum;
}

export function fieldKind(prop) {
  if (prop.enum !== undefined || prop.const !== undefined) return "select";
  switch (prop.type) {
    case "boolean":
      return "switch";
    case "object":
      return "object";
    case "number":
    case "integer":
      return "number";
    default:
      return "string";
  }
}

export function stringInputSpec(prop) {
  const multiline =
    (prop.maxLength ?? 0) >= 200 ||
    (prop.minLength ?? 0) >= 100 ||
    ["textarea", "multiline", "markdown"].includes(prop.format);
  const type =
    { email: "email", uri: "url", "uri-reference": "url", date: "date", time: "time", "date-time": "datetime-local" }[
      prop.format
    ] || "text";
  return { multiline, type };
}

export function selectHasDefault(prop) {
  const values = enumOptions(prop);
  return prop.default !== undefined && values.some((v) => v === prop.default);
}

let nextRowId = 0; // row identity for keyed rendering

function controlForValue(prop, value) {
  switch (fieldKind(prop)) {
    case "select": {
      const i = enumOptions(prop).findIndex((v) => v === value);
      return i >= 0 ? String(i) : initialControl(prop, false);
    }
    case "switch":
      return typeof value === "boolean" ? value : initialControl(prop, false);
    case "number":
      return typeof value === "number" ? { text: String(value), badInput: false } : initialControl(prop, false);
    case "string":
      return typeof value === "string" ? value : initialControl(prop, false);
    default:
      return initialControl(prop, false);
  }
}

function initialControl(prop, required) {
  switch (fieldKind(prop)) {
    case "select": {
      if (selectHasDefault(prop)) {
        return String(enumOptions(prop).findIndex((v) => v === prop.default));
      }
      // A required select renders without an empty option, so the browser
      // shows the first choice; mirror that in state. Optional selects get
      // the empty placeholder option, i.e. nothing chosen.
      return required ? "0" : "";
    }
    case "switch":
      return prop.default === true;
    case "number":
      return { text: typeof prop.default === "number" ? String(prop.default) : "", badInput: false };
    case "string":
      return typeof prop.default === "string" ? prop.default : "";
    default:
      return "";
  }
}

// initialControls builds the control map for a renderable object schema,
// honoring schema defaults.
export function initialControls(schema, base = "", out = {}) {
  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const path = base ? `${base}.${name}` : name;
    switch (fieldKind(prop)) {
      default:
        out[path] = initialControl(prop, requiredList.includes(name));
    }
  }
  return out;
}

// Merge a parsed JSON object into a fresh control map, best-effort. Used when
// toggling the JSON editor off.
export function controlsFromJson(schema, prior, json, base = "", out = {}) {
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const path = base ? `${base}.${name}` : name;
    const has = isSchemaObject(json) && json[name] !== undefined;
    switch (fieldKind(prop)) {
      default:
        out[path] = has ? controlForValue(prop, json[name]) : prior[path] ?? initialControl(prop);
    }
  }
  return out;
}

function collectLeaf(prop, required, control, errors, path) {
  const fail = (message) => {
    errors[path] = message;
    return { present: false };
  };
  switch (fieldKind(prop)) {
    case "select": {
      // NOTE: Required selects start at index "0" (see initialControl), so an
      // empty control here can only mean an optional field left unchosen, or an
      // unexpected gap, which required-ness turns into an error.
      if (control === "" || control === undefined) {
        if (required) return fail("Required");
        return { present: false };
      }
      return { present: true, value: enumOptions(prop)[Number(control)] };
    }
    case "switch":
      return { present: true, value: control === true };
    case "number": {
      const { text, badInput } = control || { text: "", badInput: false };
      if (badInput) return fail("Not a valid number");
      const v = String(text).trim();
      if (v === "") {
        if (required) return fail("Required");
        return { present: false };
      }
      const n = Number(v);
      if (!Number.isFinite(n)) return fail("Not a valid number");
      if (prop.type === "integer" && !Number.isInteger(n)) return fail("Must be an integer");
      if (prop.minimum !== undefined && n < prop.minimum) return fail(`Must be ≥ ${prop.minimum}`);
      if (prop.maximum !== undefined && n > prop.maximum) return fail(`Must be ≤ ${prop.maximum}`);
      return { present: true, value: n };
    }
    default: {
      const v = typeof control === "string" ? control : "";
      if (v === "") {
        if (required) return fail("Required");
        return { present: false };
      }
      if (prop.minLength && v.length < prop.minLength) {
        return fail(`Must be at least ${prop.minLength} characters`);
      }
      return { present: true, value: v };
    }
  }
}

function collectObject(schema, controls, base, errors) {
  const out = {};
  let any = false;
  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const path = base ? `${base}.${name}` : name;
    const required = requiredList.includes(name);
    let r;
    switch (fieldKind(prop)) {
      default:
        r = collectLeaf(prop, required, controls[path], errors, path);
    }
    if (r.present) {
      out[name] = r.value;
      any = true;
    }
  }
  return { value: out, any };
}

// Validate the whole form and builds the arguments object.
export function collect(schema, controls) {
  const errors = {};
  const r = collectObject(schema, controls, "", errors);
  return { args: r.value, any: r.any, errors, count: Object.keys(errors).length };
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
