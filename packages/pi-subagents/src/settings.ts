import {
  arr,
  bool,
  compile,
  int,
  obj,
  oneOf,
  str,
  type Validator,
} from "@earendil-works/pi-schema";

/** Effective subagent settings after field-wise defaults (S9). */
export interface SubagentSettings {
  maxConcurrent: number;
  maxTurns: number;
  backgroundByDefault: boolean;
  disabledAgents: string[];
  widget: "background" | "all" | "off";
  delivery: { mode: "grouped" | "immediate" };
}

const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  maxConcurrent: 8,
  maxTurns: 0,
  backgroundByDefault: true,
  disabledAgents: [],
  widget: "background",
  delivery: { mode: "grouped" },
};

// Any object. Its fields are checked one at a time below.
const anyObject: Validator<Record<string, unknown>> = compile(obj({}, { open: true }));

// One check per field, so an invalid field falls back alone and valid fields keep their values (S9).
const subagentSettingChecks = {
  maxConcurrent: compile(int({ minimum: 1 })),
  maxTurns: compile(int({ minimum: 0 })),
  backgroundByDefault: compile(bool()),
  disabledAgents: compile(arr(str())),
  widget: compile(oneOf(["background", "all", "off"])),
  delivery: anyObject,
};
const deliveryModeCheck = compile(oneOf(["grouped", "immediate"]));

/** Reads the `subagents` section of Pi's merged settings. Each invalid field warns once and uses its default. */
export function readSubagentSettings(
  value: unknown,
  warn: (message: string) => void,
): SubagentSettings {
  /** The value when it is valid. Otherwise one warning naming the first problem, and `undefined`. */
  function read<Value>(name: string, fieldValue: unknown, check: Validator<Value>) {
    if (fieldValue === undefined || check.check(fieldValue)) return fieldValue;
    const [error] = check.errors(fieldValue);
    // A path inside the value, such as /1 in an array, becomes disabledAgents.1.
    const where = `${name}${error?.path.replaceAll("/", ".") ?? ""}`;
    warn(
      `Invalid subagents setting ${where}: ${error?.message ?? "invalid value"}. Using the default.`,
    );
    return undefined;
  }

  function warnUnknown(prefix: string, fields: object, known: readonly string[]) {
    for (const key of Object.keys(fields)) {
      if (!known.includes(key))
        warn(`Invalid subagents setting ${prefix}${key}: unknown field. Ignoring it.`);
    }
  }

  if (value === undefined) return DEFAULT_SUBAGENT_SETTINGS;
  if (!anyObject.check(value)) {
    warn("Invalid subagents settings: expected an object. Using defaults.");
    return DEFAULT_SUBAGENT_SETTINGS;
  }
  const input: Record<string, unknown> = value;
  const checks = subagentSettingChecks;
  warnUnknown("", input, Object.keys(checks));

  const delivery: Record<string, unknown> = read("delivery", input.delivery, checks.delivery) ?? {};
  warnUnknown("delivery.", delivery, ["mode"]);

  const defaults = DEFAULT_SUBAGENT_SETTINGS;
  return {
    maxConcurrent:
      read("maxConcurrent", input.maxConcurrent, checks.maxConcurrent) ?? defaults.maxConcurrent,
    maxTurns: read("maxTurns", input.maxTurns, checks.maxTurns) ?? defaults.maxTurns,
    backgroundByDefault:
      read("backgroundByDefault", input.backgroundByDefault, checks.backgroundByDefault) ??
      defaults.backgroundByDefault,
    disabledAgents:
      read("disabledAgents", input.disabledAgents, checks.disabledAgents) ??
      defaults.disabledAgents,
    widget: read("widget", input.widget, checks.widget) ?? defaults.widget,
    delivery: {
      mode: read("delivery.mode", delivery.mode, deliveryModeCheck) ?? defaults.delivery.mode,
    },
  };
}
