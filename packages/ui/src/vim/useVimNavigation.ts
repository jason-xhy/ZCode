/**
 * Vim 键盘导航：window capture 监听 → 键位状态机 → DOM/应用动作。
 *
 * 三种交互层：
 * 1. normal 裸键（h/j/k/l、gg/G、d/u、[ ]…）；
 * 2. easymotion 式提示（f）：给视口内所有可交互元素打标签，按标签直接激活；
 * 3. sneak 式搜索（s + 两个字符）：跳转到活动区域内可见文本，;/n 下一个、,/N 上一个。
 *
 * 模式语义（不引入独立 mode 状态，避免与焦点漂移）：
 * - 焦点在可编辑元素（聊天输入框/搜索框/终端）＝ insert：除聊天输入框内的
 *   Ctrl+[ / Escape 退出外，一切按键原样放行；
 * - 焦点不在可编辑元素＝ normal：裸键由 vim 层消费；
 * - 输入法组合中、快捷键录制态、浮层打开、已被其它处理器 preventDefault 的事件一律不碰。
 */
import { useEffect, useRef, useState } from "react";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import type { VimNavigationHandlers } from "@/vim/contract.js";
import {
  exitToNormalMode,
  focusAdjacentRegion,
  focusComposer,
  focusNavEdge,
  focusOverlayContainer,
  getTopmostOverlay,
  hasOpenOverlay,
  hasVisibleStopControl,
  isEditableElement,
  isInsideOpenOverlay,
  moveNavSelection,
  scrollByLines,
  scrollFullPage,
  scrollHalfPage,
  scrollToEdge,
  VIM_COMPOSER_SELECTOR,
} from "@/vim/vimDom.js";
import {
  INITIAL_VIM_KEY_STATE,
  resolveVimKey,
  type VimAction,
  type VimKeyState,
} from "@/vim/vimKeymap.js";
import { getVimOverlay, setVimOverlay, type VimHintBadge } from "@/vim/vimOverlayStore.js";
import {
  isVimHelpOpen,
  setVimHelpOpen,
  toggleVimHelp,
  useVimNavigationEnabled,
} from "@/vim/vimStore.js";
import {
  activateTarget,
  collectHintTargets,
  findSneakMatches,
  scrollToSneakMatch,
  type HintTarget,
  type SneakMatch,
} from "@/vim/vimTargets.js";

interface HintSession {
  targets: HintTarget[];
  buffer: string;
}

interface SneakSession {
  phase: "query" | "active";
  query: string;
  matches: SneakMatch[];
  index: number;
}

function isComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(VIM_COMPOSER_SELECTOR));
}

function toBadges(targets: readonly { label: string; rect: DOMRect }[]): VimHintBadge[] {
  return targets.map((target) => ({
    label: target.label,
    left: target.rect.left,
    top: target.rect.top,
    width: target.rect.width,
    height: target.rect.height,
  }));
}

export type VimMode = "off" | "normal" | "insert";

/** 模式指示器数据源：随焦点进出输入框切换 normal/insert。 */
export function useVimMode(): VimMode {
  const enabled = useVimNavigationEnabled();
  const [insert, setInsert] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setInsert(false);
      return;
    }
    const update = () => setInsert(isEditableElement(document.activeElement));
    update();
    document.addEventListener("focusin", update, true);
    document.addEventListener("focusout", update, true);
    return () => {
      document.removeEventListener("focusin", update, true);
      document.removeEventListener("focusout", update, true);
    };
  }, [enabled]);

  return enabled ? (insert ? "insert" : "normal") : "off";
}

export function useVimNavigation(handlers: VimNavigationHandlers): void {
  const enabled = useVimNavigationEnabled();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const keyStateRef = useRef<VimKeyState>(INITIAL_VIM_KEY_STATE);
  const hintRef = useRef<HintSession | null>(null);
  const sneakRef = useRef<SneakSession | null>(null);

  useEffect(() => {
    if (!enabled) {
      keyStateRef.current = INITIAL_VIM_KEY_STATE;
      hintRef.current = null;
      sneakRef.current = null;
      setVimOverlay(null);
      return;
    }

    const endHint = () => {
      hintRef.current = null;
      setVimOverlay(null);
    };

    const beginHint = () => {
      const scope = getTopmostOverlay();
      const targets = collectHintTargets(scope ?? document);
      if (targets.length === 0) {
        // 不静默返回：用户按了 f 就必须知道“当前作用域没有可跳转目标”，
        // 否则表现为按键失灵。Esc 可关（见 handleKeyDown 顶部）。
        setVimOverlay({ kind: "message", messageId: "vim.overlay.noTargets" });
        return;
      }
      hintRef.current = { targets, buffer: "" };
      setVimOverlay({ kind: "hints", buffer: "", badges: toBadges(targets) });
    };

    const handleHintKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === "Escape") {
        endHint();
        return;
      }
      const session = hintRef.current;
      if (!session) {
        return;
      }
      if (event.key === "Backspace") {
        session.buffer = session.buffer.slice(0, -1);
        const remaining = session.targets.filter((target) =>
          target.label.startsWith(session.buffer),
        );
        setVimOverlay({ kind: "hints", buffer: session.buffer, badges: toBadges(remaining) });
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
        return;
      }
      const buffer = session.buffer + event.key.toLowerCase();
      const remaining = session.targets.filter((target) => target.label.startsWith(buffer));
      if (remaining.length === 0) {
        endHint();
        return;
      }
      const exact = remaining.find((target) => target.label === buffer);
      if (exact) {
        endHint();
        activateTarget(exact.element);
        return;
      }
      session.buffer = buffer;
      setVimOverlay({ kind: "hints", buffer, badges: toBadges(remaining) });
    };

    const endSneak = () => {
      sneakRef.current = null;
      setVimOverlay(null);
    };

    const showSneak = (session: SneakSession) => {
      setVimOverlay({
        kind: "sneak",
        query: session.query,
        badges: session.matches.map((match, index) => ({
          label: String(index + 1),
          left: match.rect.left,
          top: match.rect.top,
          width: match.rect.width,
          height: match.rect.height,
        })),
        activeIndex: session.index,
      });
    };

    const moveSneak = (delta: 1 | -1) => {
      const session = sneakRef.current;
      if (!session || session.phase !== "active" || session.matches.length === 0) {
        return;
      }
      session.index = (session.index + delta + session.matches.length) % session.matches.length;
      scrollToSneakMatch(session.matches[session.index]!);
      showSneak(session);
    };

    const beginSneak = () => {
      sneakRef.current = { phase: "query", query: "", matches: [], index: 0 };
      setVimOverlay({ kind: "sneak", query: "", badges: [], activeIndex: 0 });
    };

    const handleSneakKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      const session = sneakRef.current;
      if (!session) {
        return;
      }
      if (event.key === "Escape") {
        endSneak();
        return;
      }
      if (session.phase === "query") {
        if (event.key === "Backspace") {
          session.query = session.query.slice(0, -1);
          setVimOverlay({ kind: "sneak", query: session.query, badges: [], activeIndex: 0 });
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
          return;
        }
        session.query += event.key;
        if (session.query.length < 2) {
          setVimOverlay({ kind: "sneak", query: session.query, badges: [], activeIndex: 0 });
          return;
        }
        const matches = findSneakMatches(session.query, getTopmostOverlay() ?? undefined);
        if (matches.length === 0) {
          // 无命中时不要静默关窗：用户会以为 s 键根本没生效。保持查询态显示
          // "无匹配"，可退格重输或 Esc 退出；继续输入则按更长的串再搜。
          setVimOverlay({ kind: "sneak", query: session.query, badges: [], activeIndex: 0 });
          return;
        }
        session.phase = "active";
        session.matches = matches;
        session.index = 0;
        scrollToSneakMatch(matches[0]!);
        showSneak(session);
        return;
      }

      if (event.key === ";" || event.key === "n") {
        moveSneak(1);
        return;
      }
      if (event.key === "," || event.key === "N") {
        moveSneak(-1);
        return;
      }
      if (event.key === "Enter") {
        const match = session.matches[session.index];
        endSneak();
        if (match?.element) {
          activateTarget(match.element);
        }
      }
    };

    const runAction = (action: VimAction) => {
      const currentHandlers = handlersRef.current;
      switch (action.type) {
        case "move":
          if (!moveNavSelection(action.delta)) {
            scrollByLines(action.delta);
          }
          break;
        case "halfPage":
          scrollHalfPage(action.direction);
          break;
        case "page":
          scrollFullPage(action.direction);
          break;
        case "top":
          if (!focusNavEdge("first")) {
            scrollToEdge("top");
          }
          break;
        case "bottom":
          if (!focusNavEdge("last")) {
            scrollToEdge("bottom");
          }
          break;
        case "focusRegion":
          focusAdjacentRegion(action.direction);
          break;
        case "focusComposer":
          focusComposer();
          break;
        case "commandCenter":
          currentHandlers.openCommandCenter();
          break;
        case "find":
          currentHandlers.findInTask();
          break;
        case "hint":
          beginHint();
          break;
        case "sneak":
          beginSneak();
          break;
        case "toggleSidebar":
          currentHandlers.toggleSidebar();
          break;
        case "toggleTerminal":
          currentHandlers.toggleTerminal();
          break;
        case "conversation":
          if (action.direction > 0) {
            currentHandlers.nextConversation();
          } else {
            currentHandlers.previousConversation();
          }
          break;
        case "toggleHelp":
          toggleVimHelp();
          break;
        case "exitToNormal":
          setVimHelpOpen(false);
          exitToNormalMode();
          break;
        case "none":
        default:
          break;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) {
        return;
      }
      if (isShortcutRecordingActive()) {
        return;
      }

      // 提示/搜索会话优先：会话期间所有按键归会话消费（含 Esc/退格/数字）。
      if (hintRef.current) {
        handleHintKeyDown(event);
        return;
      }
      if (sneakRef.current) {
        handleSneakKeyDown(event);
        return;
      }

      // 无可跳转目标的提示只做视觉反馈；Esc 先清掉它，再继续走帮助/浮层/应用
      // 的 Escape 语义（帮助浮层打开时一次 Esc 即可同时收起两者）。
      if (getVimOverlay()?.kind === "message" && event.key === "Escape") {
        setVimOverlay(null);
      }

      // 万能离开键：终端/浏览器内嵌页/任何输入框都吃不到 Ctrl+Alt+Esc，
      // 用它可以无条件回到主区普通模式（终端里 Ctrl+[ 是 shell 的 Esc，不能抢）。
      if (event.ctrlKey && event.altKey && event.key === "Escape") {
        event.preventDefault();
        keyStateRef.current = INITIAL_VIM_KEY_STATE;
        exitToNormalMode();
        return;
      }

      // 帮助浮层由 vim 层自己托管：? / Esc 必须能关闭。若落到下面的通用浮层
      // 让路分支，帮助里写的「按 ? 或 Esc 关闭」永远不生效（只剩鼠标点背景）。
      if (
        isVimHelpOpen() &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === "?" || event.key === "Escape")
      ) {
        event.preventDefault();
        keyStateRef.current = INITIAL_VIM_KEY_STATE;
        setVimHelpOpen(false);
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      if (isEditableElement(target)) {
        // insert 模式：裸键（含 f/s）保持文本输入语义，vim 层不得抢。
        const ctrlBracket =
          event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "[";
        if (ctrlBracket) {
          // 浮层（dialog/alertdialog/menu/listbox）内的输入框：Ctrl+[ 退出输入
          // 焦点、浮层保持打开，随后 f/s 立即可用。这是输入态到导航态的纯键盘
          // 通道；不能像终端那样把 Ctrl+[ 当 shell Esc 放行。
          const overlay = getTopmostOverlay();
          if (overlay && isInsideOpenOverlay(target)) {
            event.preventDefault();
            keyStateRef.current = INITIAL_VIM_KEY_STATE;
            focusOverlayContainer(overlay);
            return;
          }
          // 非浮层输入框：只有聊天输入框的 Ctrl+[ 归 vim 层；搜索框/终端/编辑器
          // 保持原语义（终端里 Ctrl+[ 就是 Esc）。
          if (isComposerTarget(target)) {
            event.preventDefault();
            keyStateRef.current = INITIAL_VIM_KEY_STATE;
            runAction({ type: "exitToNormal" });
          }
          return;
        }
        if (isComposerTarget(target) && event.key === "Escape") {
          // 生成中 Escape = 停止生成；浮层打开 = 关闭浮层。两者都不抢。
          if (hasVisibleStopControl() || hasOpenOverlay()) {
            return;
          }
          event.preventDefault();
          keyStateRef.current = INITIAL_VIM_KEY_STATE;
          runAction({ type: "exitToNormal" });
        }
        return;
      }

      // normal 模式：浮层打开时 f/s 的作用域 = 最顶层浮层，标签/搜索都不许
      // 落到底下的背景页面。焦点在浮层内的非输入元素（菜单项/列表项/按钮/
      // 容器）时直接可用；浮层内输入框已在上面的 editable 分支处理（Ctrl+[）。
      if (hasOpenOverlay()) {
        if (
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          (event.key === "f" || event.key === "s")
        ) {
          event.preventDefault();
          keyStateRef.current = INITIAL_VIM_KEY_STATE;
          runAction(event.key === "f" ? { type: "hint" } : { type: "sneak" });
        }
        return;
      }

      const result = resolveVimKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
        },
        keyStateRef.current,
      );
      keyStateRef.current = result.state;
      if (result.action.type === "none") {
        return;
      }
      event.preventDefault();
      runAction(result.action);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      setVimOverlay(null);
    };
  }, [enabled]);
}

/** 供 VimModeIndicator 使用：当前是否存在可见输入焦点。 */
export function useIsInsertMode(): boolean {
  return useVimMode() === "insert";
}
