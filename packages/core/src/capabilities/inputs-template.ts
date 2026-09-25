import { projectInputsTemplate, renderInputsTemplate } from "mthds/protocol";
import type { InputsTemplateFormat, PipeInputFormDescriptor } from "mthds/protocol";

import { asRecord } from "./shared.js";

/**
 * The fill-in inputs template for one pipe, projected client-side from the
 * pipe's `input_form` descriptor with the standard's own projection
 * (`mthds/protocol`'s `projectInputsTemplate`), never fetched from a build
 * route.
 *
 * One helper for every tool that hands a model a template.
 * `pipelex_show_method` is its first caller; the workshop's
 * `mthds_inputs_template` still reads `POST /v1/build/inputs` and moves here
 * when that route is retired (L-260829-820e74), which is why the helper takes
 * the two options that tool exposes — the shape and the serialization — rather
 * than only the one the console uses.
 *
 * The descriptor is wire data, so the helper reads it the way every other
 * consumer of a report artifact in this repo does: it checks what arrived
 * rather than trusting the declared type, and a descriptor it cannot project
 * yields no template instead of a thrown `TypeError`.
 */

export interface InputsTemplateOptions {
  /**
   * `true` (the default) keeps the ceremonial `{ concept, content }` envelope on
   * every slot; `false` emits the light shape a smart-inputs run accepts directly.
   */
  explicit?: boolean;
  /** The serialization of `text`: `"json"` (the default) or `"toml"`. */
  format?: InputsTemplateFormat;
}

/** A projected template. The JSON arm also carries it as a plain object, for `structuredContent`. */
export type ProjectedInputsTemplate =
  | {
      format: "json";
      explicit: boolean;
      /**
       * The template as a plain JSON object. A float placeholder the projection
       * carries as `TemplateFloat` becomes a plain number here; `text` keeps its
       * decimal point.
       */
      inputs: Record<string, unknown>;
      /** The template as the standard's own writer spells it, byte-identical with the Python twin. */
      text: string;
    }
  | { format: "toml"; explicit: boolean; text: string };

/**
 * Project the template for `pipeRef` from a whole `input_form` artifact (the
 * report's map of pipe ref to descriptor), or `undefined` when the artifact
 * holds no usable descriptor for that pipe: no entry, an entry with no field
 * list, or one the projection cannot walk.
 */
export function inputsTemplateFor(
  inputForm: unknown,
  pipeRef: string,
  options: InputsTemplateOptions = {},
): ProjectedInputsTemplate | undefined {
  const forms = asRecord(inputForm);
  const descriptor = forms === undefined ? undefined : asRecord(forms[pipeRef]);
  if (descriptor === undefined || !Array.isArray(descriptor.fields)) {
    return undefined;
  }
  return projectDescriptor(descriptor as unknown as PipeInputFormDescriptor, options);
}

function projectDescriptor(
  descriptor: PipeInputFormDescriptor,
  options: InputsTemplateOptions,
): ProjectedInputsTemplate | undefined {
  const explicit = options.explicit ?? true;
  const format = options.format ?? "json";
  try {
    const text = renderInputsTemplate(descriptor, { explicit, format });
    if (format === "toml") {
      return { format, explicit, text };
    }
    // `TemplateFloat` unwraps through its own `toJSON`, so one round trip turns
    // the projection into the plain value tree `structuredContent` needs.
    const inputs = JSON.parse(
      JSON.stringify(projectInputsTemplate(descriptor, { explicit })),
    ) as Record<string, unknown>;
    return { format, explicit, inputs, text };
  } catch {
    // A node the projection cannot walk is the producer's defect, not the
    // caller's; the tool that asked says it has no template rather than failing.
    return undefined;
  }
}
