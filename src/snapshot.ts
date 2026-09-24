import type { IBufferCell, IBufferLine, Terminal } from "@xterm/headless";
import type { CellStyle, MouseEncoding, ScreenState } from "./contracts.js";

function cellStyle(cell: IBufferCell): CellStyle {
  const style: CellStyle = {};
  if (cell.isFgPalette()) style.foreground = { kind: "palette", index: cell.getFgColor() };
  if (cell.isFgRGB()) {
    style.foreground = { kind: "rgb", value: `#${cell.getFgColor().toString(16).padStart(6, "0")}` };
  }
  if (cell.isBgPalette()) style.background = { kind: "palette", index: cell.getBgColor() };
  if (cell.isBgRGB()) {
    style.background = { kind: "rgb", value: `#${cell.getBgColor().toString(16).padStart(6, "0")}` };
  }
  if (Boolean(cell.isBold())) style.bold = true;
  if (Boolean(cell.isDim())) style.dim = true;
  if (Boolean(cell.isItalic())) style.italic = true;
  if (Boolean(cell.isUnderline())) style.underline = true;
  if (Boolean(cell.isBlink())) style.blink = true;
  if (Boolean(cell.isInverse())) style.inverse = true;
  if (Boolean(cell.isInvisible())) style.invisible = true;
  if (Boolean(cell.isStrikethrough())) style.strikethrough = true;
  if (Boolean(cell.isOverline())) style.overline = true;
  return style;
}

function lineText(line: IBufferLine | undefined): string {
  if (!line) return "";
  let text = "";
  let end = 0;
  for (let column = 0; column < line.length; column++) {
    const cell = line.getCell(column)!;
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = Boolean(cell.isInvisible()) ? " ".repeat(width) : cell.getChars() || " ";
    text += chars;
    if (chars !== " ".repeat(width) || !cell.isAttributeDefault()) end = text.length;
  }
  return text.slice(0, end);
}

export function captureScreen(
  terminal: Terminal,
  cursorVisible: boolean,
  mouseEncoding: MouseEncoding,
  scrollbackLines = 0,
): ScreenState {
  const active = terminal.buffer.active;
  const snapshot: ScreenState = {
    cols: terminal.cols,
    rows: terminal.rows,
    buffer: active.type,
    screen: [],
    cursor: {
      row: active.cursorY + 1,
      column: Math.min(active.cursorX + 1, terminal.cols),
      visible: cursorVisible,
    },
    styles: {},
    spans: [],
    mouse: { tracking: terminal.modes.mouseTrackingMode, encoding: mouseEncoding },
  };
  const styleIds = new Map<string, string>();
  for (let row = 1; row <= terminal.rows; row++) {
    const line = active.getLine(active.baseY + row - 1);
    snapshot.screen.push(lineText(line));
    for (let column = 1; column <= terminal.cols; column++) {
      const cell = line?.getCell(column - 1);
      if (!cell) continue;
      const style = cellStyle(cell);
      const key = JSON.stringify(style);
      if (key === "{}") continue;
      let styleId = styleIds.get(key);
      if (!styleId) {
        styleId = `s${styleIds.size + 1}`;
        styleIds.set(key, styleId);
        snapshot.styles[styleId] = style;
      }
      const previous = snapshot.spans.at(-1);
      if (previous?.row === row && previous.endColumn === column - 1 && previous.styleId === styleId) {
        previous.endColumn = column;
      } else {
        snapshot.spans.push({ row, startColumn: column, endColumn: column, styleId });
      }
    }
  }
  if (scrollbackLines > 0) {
    const normal = terminal.buffer.normal;
    const lines: string[] = [];
    for (let index = Math.max(0, normal.baseY - scrollbackLines); index < normal.baseY; index++) {
      lines.push(lineText(normal.getLine(index)));
    }
    snapshot.history = { lines, availableLines: normal.baseY };
  }
  return snapshot;
}

export function visibleFingerprint(snapshot: ScreenState): string {
  const { cols, rows, buffer, screen, cursor, styles, spans } = snapshot;
  return JSON.stringify({ cols, rows, buffer, screen, cursor, styles, spans });
}
