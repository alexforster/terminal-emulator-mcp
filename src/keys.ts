export const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];
export const NAMED_KEYS = [
  "Enter", "Tab", "Backspace", "Escape", "Space",
  "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Insert", "Delete",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;

const cursorKeys = new Map([
  ["Up", "A"], ["Down", "B"], ["Right", "C"], ["Left", "D"], ["Home", "H"], ["End", "F"],
]);
const functionKeys = new Map([["F1", "P"], ["F2", "Q"], ["F3", "R"], ["F4", "S"]]);
const tildeKeys = new Map([
  ["Insert", 2], ["Delete", 3], ["PageUp", 5], ["PageDown", 6],
  ["F5", 15], ["F6", 17], ["F7", 18], ["F8", 19], ["F9", 20], ["F10", 21], ["F11", 23], ["F12", 24],
]);
const controlCharacters = new Map([
  [" ", 0], ["@", 0], ["[", 27], ["\\", 28], ["]", 29], ["^", 30], ["_", 31], ["?", 127],
]);

export function encodeKey(key: string, modifiers: readonly Modifier[], applicationCursorKeys: boolean): string {
  if (new Set(modifiers).size !== modifiers.length) throw new RangeError("Duplicate key modifiers");
  const ctrl = modifiers.includes("Ctrl");
  const alt = modifiers.includes("Alt");
  const shift = modifiers.includes("Shift");
  const parameter = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl);
  const cursor = cursorKeys.get(key);
  const fn = functionKeys.get(key);
  if (cursor || fn) {
    if (parameter > 1) return `\x1b[1;${parameter}${cursor ?? fn}`;
    return `\x1b${fn || applicationCursorKeys ? "O" : "["}${cursor ?? fn}`;
  }
  const tilde = tildeKeys.get(key);
  if (tilde) return `\x1b[${tilde}${parameter > 1 ? `;${parameter}` : ""}~`;
  if (key === "Tab" && !ctrl && !alt) return shift ? "\x1b[Z" : "\t";
  if (shift) throw new RangeError(`Shift is unsupported for ${key}; supply the resulting printable character`);

  let character: string | undefined;
  switch (key) {
    case "Enter": if (!ctrl) character = "\r"; break;
    case "Backspace": character = ctrl ? "\b" : "\x7f"; break;
    case "Escape": if (!ctrl) character = "\x1b"; break;
    case "Space": character = ctrl ? "\0" : " "; break;
    default:
      if (/^[\x20-\x7e]$/.test(key)) {
        if (!ctrl) character = key;
        else {
          const code = /^[a-z]$/i.test(key) ? key.toUpperCase().charCodeAt(0) - 64 : controlCharacters.get(key);
          if (code !== undefined) character = String.fromCharCode(code);
        }
      }
  }
  if (character === undefined) throw new RangeError(`Unsupported key or modifier combination: ${key}`);
  return `${alt ? "\x1b" : ""}${character}`;
}
