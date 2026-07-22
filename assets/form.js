import { h, text } from "./hyperapp.js";
import { fieldKind, stringInputSpec } from "./schema.js";

function labelText(name, required) {
  return required ? `${name} *` : name;
}

function controlId(path) {
  return `mc-${path}`;
}

// Wraps a control with the shared chrome.
function fieldShell({ path, extraClass, invalid, desc, error, children }) {
  return h(
    "div",
    { key: path, class: ["field", extraClass, { invalid: Boolean(invalid) }] },
    [
      ...children,
      desc ? h("div", { class: "field-desc" }, text(desc)) : false,
      h("div", { class: "field-error", hidden: !error }, error ? text(error) : []),
    ],
  );
}

function textField({ path, name, prop, required, value, error, desc, oninput }) {
  const { multiline, type } = stringInputSpec(prop);
  const id = controlId(path);
  const shared = { id, placeholder: " ", value, oninput };
  const control = multiline
    ? h("textarea", { ...shared, rows: 4, maxlength: prop.maxLength || undefined })
    : h("input", { ...shared, type, maxlength: prop.maxLength || undefined });
  return fieldShell({
    path,
    invalid: error,
    desc,
    error,
    children: [
      h("div", { class: ["filled", { multiline }] }, [
        control,
        h("label", { for: id }, text(labelText(name, required))),
      ]),
    ],
  });
}

function numberField({ path, name, prop, required, control, error, desc, oninput }) {
  const id = controlId(path);
  return fieldShell({
    path,
    invalid: error,
    desc,
    error,
    children: [
      h("div", { class: "filled" }, [
        h("input", {
          id,
          type: "number",
          placeholder: " ",
          step: prop.type === "integer" ? "1" : "any",
          min: prop.minimum !== undefined ? String(prop.minimum) : undefined,
          max: prop.maximum !== undefined ? String(prop.maximum) : undefined,
          value: control ? control.text : "",
          // Lets the run action re-capture live validity (some engines fire
          // the input event before validity.badInput is up to date).
          "data-path": path,
          oninput,
        }),
        h("label", { for: id }, text(labelText(name, required))),
      ]),
    ],
  });
}

function switchField({ path, name, required, checked, desc, ontoggle }) {
  return fieldShell({
    path,
    desc,
    error: null,
    children: [
      h("label", { class: "switch-row" }, [
        h("span", { class: "switch" }, [
          h("input", { id: controlId(path), type: "checkbox", checked: checked === true, onchange: ontoggle }),
          h("span", { class: "track" }),
          h("span", { class: "thumb" }),
        ]),
        h("span", { class: "switch-label" }, text(labelText(name, required))),
      ]),
    ],
  });
}

function leafField({ path, name, prop, required, control, error, desc, handlers }) {
  switch (fieldKind(prop)) {
    case "switch":
      return switchField({
        path,
        name,
        required,
        checked: control === true,
        desc,
        ontoggle: (_, event) => [handlers.SetToggle, { path, checked: event.target.checked }],
      });
    case "number":
      return numberField({
        path,
        name,
        prop,
        required,
        control,
        error,
        desc,
        oninput: (_, event) => [
          handlers.SetNumber,
          { path, text: event.target.value, badInput: Boolean(event.target.validity && event.target.validity.badInput) },
        ],
      });
    default:
      return textField({
        path,
        name,
        prop,
        required,
        value: typeof control === "string" ? control : "",
        error,
        desc,
        oninput: (_, event) => [handlers.SetText, { path, value: event.target.value }],
      });
  }
}

function objectFields({ schema, controls, errors, base, handlers }) {
  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties || {}).map(([name, prop]) => {
    const path = base ? `${base}.${name}` : name;
    const required = requiredList.includes(name);
    const desc = typeof prop.description === "string" ? prop.description : "";
    switch (fieldKind(prop)) {
      default:
        return leafField({ path, name, prop, required, control: controls[path], error: errors[path], desc, handlers });
    }
  });
}

function jsonEditor({ jsonText, jsonError, handlers }) {
  return [
    h("textarea", {
      class: "json-textarea",
      spellcheck: false,
      "aria-label": "Tool arguments as JSON",
      value: jsonText,
      oninput: (_, event) => [handlers.SetJsonText, event.target.value],
    }),
    h("div", { class: "field-error json-parse-error", hidden: !jsonError }, jsonError ? text(jsonError) : []),
  ];
}

// Top-level form component: the schema-driven fields and the
// JSON editor, one of which is hidden depending on the mode.
export function toolForm({ form, handlers }) {
  return [
    h("div", { class: "form-fields", hidden: form.jsonMode }, [
      form.empty
        ? h("p", { class: "no-args" }, text("This tool takes no arguments."))
        : form.renderable
          ? h(
              "div",
              { class: "object-fields" },
              objectFields({ schema: form.schema, controls: form.controls, errors: form.errors, base: "", handlers }),
            )
          : false,
    ]),
    h(
      "div",
      { class: "json-editor", hidden: !form.jsonMode },
      jsonEditor({ jsonText: form.jsonText, jsonError: form.jsonError, handlers }),
    ),
  ];
}
