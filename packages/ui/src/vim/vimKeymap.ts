/**
 * Vim 导航键位状态机（纯函数，无 DOM 依赖）。
 *
 * 设计约束：
 * - 与快捷键内核（shortcuts/）职责隔离：快捷键内核只认「修饰键组合 → 命令 ID」，
 *   本模块只认「普通模式下的裸键 / 序列 / 计数」，由 useVimNavigation 负责 DOM 执行；
 * - 支持 g 前缀序列（gg）与数字计数（5j），序列 1s 内未续按即失效；
 * - 输入法组合中（isComposing / Process / Dead / keyCode 229）与长按 repeat 一律忽略。
 */

export interface VimKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface VimKeyState {
  /** 已按下 g，等待第二个 g。 */
  pendingG: boolean;
  /** 数字前缀累积的计数；0 表示未指定。 */
  count: number;
  /** 上次按键时间，用于序列超时。 */
  updatedAt: number;
}

export type VimAction =
  | { type: "move"; delta: number }
  | { type: "halfPage"; direction: 1 | -1 }
  | { type: "page"; direction: 1 | -1 }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "focusRegion"; direction: 1 | -1 }
  | { type: "focusComposer" }
  | { type: "commandCenter" }
  | { type: "find" }
  | { type: "hint" }
  | { type: "sneak" }
  | { type: "toggleSidebar" }
  | { type: "toggleTerminal" }
  | { type: "conversation"; direction: 1 | -1 }
  | { type: "toggleHelp" }
  | { type: "exitToNormal" }
  | { type: "none" };

export const INITIAL_VIM_KEY_STATE: VimKeyState = {
  pendingG: false,
  count: 0,
  updatedAt: 0,
};

/** g 序列的超时时间：超时后延迟按下的 g 视为新的序列起点。 */
export const VIM_SEQUENCE_TIMEOUT_MS = 1000;

function isNoise(event: VimKeyEvent): boolean {
  return (
    event.repeat === true ||
    event.isComposing === true ||
    event.key === "Process" ||
    event.key === "Dead" ||
    event.keyCode === 229
  );
}

function resolved(action: VimAction): { action: VimAction; state: VimKeyState } {
  return { action, state: INITIAL_VIM_KEY_STATE };
}

/**
 * 解析一次普通模式按键。
 *
 * 调用方需保证：事件目标不是可编辑元素、不在快捷键录制态、事件未被其它处理器消费。
 * state 需在调用间保持（用于 g 序列与计数）；返回值 state 为下一次的起始状态。
 */
export function resolveVimKey(
  event: VimKeyEvent,
  state: VimKeyState,
  now: number = Date.now(),
): { action: VimAction; state: VimKeyState } {
  if (isNoise(event)) {
    return { action: { type: "none" }, state };
  }

  const expired = state.pendingG && now - state.updatedAt > VIM_SEQUENCE_TIMEOUT_MS;
  let current: VimKeyState = expired ? INITIAL_VIM_KEY_STATE : state;

  const ctrl = event.ctrlKey === true;
  const meta = event.metaKey === true;
  const alt = event.altKey === true;

  if (ctrl || meta || alt) {
    // Ctrl 组合：只认 vim 翻页/退出族，其余放行给应用快捷键。
    if (meta || alt) {
      return resolved({ type: "none" });
    }
    switch (event.key) {
      case "[":
        return resolved({ type: "exitToNormal" });
      case "d":
        return resolved({ type: "halfPage", direction: 1 });
      case "u":
        return resolved({ type: "halfPage", direction: -1 });
      case "f":
        return resolved({ type: "page", direction: 1 });
      case "b":
        return resolved({ type: "page", direction: -1 });
      default:
        return resolved({ type: "none" });
    }
  }

  // 数字计数前缀：1-9 起始，0 只能跟在已有计数后（与 vim 的 10j 一致）。
  if (/^[0-9]$/.test(event.key)) {
    if (event.key === "0" && current.count === 0) {
      return { action: { type: "none" }, state: current };
    }
    const nextCount = Math.min(current.count * 10 + Number(event.key), 9999);
    return {
      action: { type: "none" },
      state: { ...current, count: nextCount, updatedAt: now },
    };
  }

  const count = current.count > 0 ? current.count : 1;

  if (current.pendingG) {
    if (event.key === "g") {
      return resolved({ type: "top" });
    }
    // g 后跟其它键不是合法序列：丢弃并重新按当前键处理。
    current = INITIAL_VIM_KEY_STATE;
  }

  switch (event.key) {
    case "g":
      return {
        action: { type: "none" },
        state: { pendingG: true, count: current.count, updatedAt: now },
      };
    case "j":
      return resolved({ type: "move", delta: count });
    case "k":
      return resolved({ type: "move", delta: -count });
    case "d":
      return resolved({ type: "halfPage", direction: 1 });
    case "u":
      return resolved({ type: "halfPage", direction: -1 });
    case "G":
      return resolved({ type: "bottom" });
    case "h":
      return resolved({ type: "focusRegion", direction: -1 });
    case "l":
      return resolved({ type: "focusRegion", direction: 1 });
    case "i":
    case "a":
      return resolved({ type: "focusComposer" });
    case ":":
      return resolved({ type: "commandCenter" });
    case "/":
      return resolved({ type: "find" });
    // easymotion 式提示跳转 / sneak 式双字符文本跳转
    case "f":
      return resolved({ type: "hint" });
    case "s":
      return resolved({ type: "sneak" });
    case "b":
      return resolved({ type: "toggleSidebar" });
    case "t":
      return resolved({ type: "toggleTerminal" });
    case "]":
      return resolved({ type: "conversation", direction: 1 });
    case "[":
      return resolved({ type: "conversation", direction: -1 });
    case "?":
      return resolved({ type: "toggleHelp" });
    case "Escape":
      return resolved({ type: "exitToNormal" });
    default:
      return resolved({ type: "none" });
  }
}
