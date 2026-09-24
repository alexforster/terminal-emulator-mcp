import { ToolError, type InputAction, type InputModes } from "./contracts.js";
import { encodeKey } from "./keys.js";

export function encodeInput(action: Exclude<InputAction, { type: "wait" }>, modes: InputModes): Buffer {
  switch (action.type) {
    case "text":
      return Buffer.from(action.text, "utf8");
    case "paste": {
      const text = action.text.replace(/\r?\n/g, "\r");
      return Buffer.from(modes.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text, "utf8");
    }
    case "key":
      return Buffer.from(encodeKey(action.key, action.modifiers, modes.applicationCursorKeys), "utf8");
    case "raw":
      return Buffer.from(action.bytes);
    case "focus":
      return Buffer.from(modes.focusReporting ? (action.focused ? "\x1b[I" : "\x1b[O") : "");
    case "mouse":
      return encodeMouse(action, modes);
  }
}

function encodeMouse(action: Extract<InputAction, { type: "mouse" }>, modes: InputModes): Buffer {
  if (modes.mouseTracking === "none") throw new ToolError("UNSUPPORTED_INPUT", "Mouse reporting is disabled");
  if (modes.mouseEncoding === "sgr-pixels") {
    throw new ToolError("UNSUPPORTED_INPUT", "Pixel mouse encoding does not accept cell coordinates");
  }
  if (action.column > modes.cols || action.row > modes.rows) {
    throw new ToolError("UNSUPPORTED_INPUT", "Mouse coordinates are outside the terminal screen");
  }
  if (modes.mouseEncoding === "legacy" && (action.column > 223 || action.row > 223)) {
    throw new ToolError("UNSUPPORTED_INPUT", "Legacy mouse encoding requires coordinates at most 223");
  }
  if (modes.mouseTracking === "x10" && (action.event === "scroll" || action.modifiers.length > 0)) {
    throw new ToolError("UNSUPPORTED_INPUT", "X10 tracking supports only unmodified mouse clicks");
  }
  const modifierBits = Number(action.modifiers.includes("Shift")) * 4
    + Number(action.modifiers.includes("Alt")) * 8 + Number(action.modifiers.includes("Ctrl")) * 16;
  const button = action.event === "click"
    ? { left: 0, middle: 1, right: 2 }[action.button]
    : action.direction === "up" ? 64 : 65;
  const code = button + modifierBits;

  function report(release: boolean): Buffer {
    if (modes.mouseEncoding === "sgr") {
      return Buffer.from(`\x1b[<${code};${action.column};${action.row}${release ? "m" : "M"}`);
    }
    const legacyButton = release ? 3 + modifierBits : code;
    return Buffer.from([27, 91, 77, legacyButton + 32, action.column + 32, action.row + 32]);
  }

  const press = report(false);
  if (action.event === "scroll") return Buffer.concat(Array.from({ length: action.count }, () => press));
  return modes.mouseTracking === "x10" ? press : Buffer.concat([press, report(true)]);
}
