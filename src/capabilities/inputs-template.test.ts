import { describe, expect, it } from "vitest";

import type { InputForm } from "@pipelex/sdk";
import { projectInputsTemplate, renderInputsTemplate } from "mthds/protocol";

import { inputsTemplateFor } from "./inputs-template.js";

const inputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "topic",
        kind: "prose",
        concept_ref: "native.Text",
        required: true,
        presence: "plain",
        gating: true,
      },
      {
        name: "photo",
        kind: "image",
        concept_ref: "native.Image",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
};

const descriptor = inputForm["demo.main"]!;

describe("inputsTemplateFor", () => {
  it("projects the explicit JSON template by default, as the standard spells it", () => {
    const template = inputsTemplateFor(inputForm, "demo.main");

    expect(template?.format).toBe("json");
    expect(template?.explicit).toBe(true);
    expect(template?.text).toBe(
      renderInputsTemplate(descriptor, { explicit: true, format: "json" }),
    );
    if (template?.format !== "json") throw new Error("expected the JSON arm");
    expect(template.inputs).toEqual(
      JSON.parse(JSON.stringify(projectInputsTemplate(descriptor, { explicit: true }))),
    );
    expect(Object.keys(template.inputs)).toEqual(["topic", "photo"]);
  });

  it("projects the light shape and the TOML serialization when asked", () => {
    const light = inputsTemplateFor(inputForm, "demo.main", { explicit: false });
    const toml = inputsTemplateFor(inputForm, "demo.main", { format: "toml" });

    expect(light?.explicit).toBe(false);
    expect(light?.text).toBe(renderInputsTemplate(descriptor, { explicit: false, format: "json" }));
    expect(toml).toEqual({
      format: "toml",
      explicit: true,
      text: renderInputsTemplate(descriptor, { explicit: true, format: "toml" }),
    });
  });

  it("yields no template for a pipe the artifact does not describe", () => {
    expect(inputsTemplateFor(inputForm, "demo.other")).toBeUndefined();
    expect(inputsTemplateFor(undefined, "demo.main")).toBeUndefined();
    expect(inputsTemplateFor(null, "demo.main")).toBeUndefined();
    expect(inputsTemplateFor([], "demo.main")).toBeUndefined();
  });

  it("yields no template, rather than throwing, for a descriptor it cannot walk", () => {
    // Wire data: a descriptor whose field list is not a list, or whose node is
    // not a node, is the producer's defect.
    expect(inputsTemplateFor({ "demo.main": { fields: "topic" } }, "demo.main")).toBeUndefined();
    expect(inputsTemplateFor({ "demo.main": { fields: [null] } }, "demo.main")).toBeUndefined();
  });

  it("gives an empty template for a pipe that declares no inputs", () => {
    const template = inputsTemplateFor({ "demo.main": { fields: [] } }, "demo.main");

    if (template?.format !== "json") throw new Error("expected the JSON arm");
    expect(template.inputs).toEqual({});
  });
});
