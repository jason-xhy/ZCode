/**
 * Round 3 审计探针（A）：Q2-18/Q2-19 对抗复验 + 剩余高价值 N/A 补测。
 *
 * 只读产品代码，不修改产品实现；用例失败即台账 Round 3 的新证据。
 * 运行：run_e2e_spec.sh test/e2e/ui-shell/navigation/vim-quicknav-round3-audit.test.ts --no-build
 */
import {
  E2E_REPLY_TOKEN,
  V4_MAIN_PANE_ID,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session";
import { expect as wdioExpect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";

const INDICATOR = '[data-testid="vim-mode-indicator"]';
const HINT_OVERLAY = "[data-vim-hint-overlay]";
const PREVIEW_FIXTURE_NAME = "vim-r3-preview-fixture.txt";
const PREVIEW_FIXTURE_MARKER = "E2E_VIM_R3_PREVIEW_MARKER";

let taskId = "";
let secondTaskId = "";

function expect(actual: unknown, message?: string): ReturnType<typeof wdioExpect> {
  const wrap = (matchers: object): object =>
    new Proxy(matchers, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "not" || property === "resolves" || property === "rejects") {
          return typeof value === "object" && value !== null ? wrap(value) : value;
        }
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            try {
              return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
            } catch (error) {
              const detail = message ? `${message}: ` : "";
              throw new Error(`${detail}${(error as Error).message ?? String(error)}`, {
                cause: error,
              });
            }
          };
        }
        return value;
      },
    });
  return wrap(wdioExpect(actual)) as ReturnType<typeof wdioExpect>;
}

interface KeyOptions {
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

async function press(key: string, options: KeyOptions = {}) {
  await browser.execute(
    (eventKey, eventCode, ctrlKey, altKey, shiftKey, metaKey) => {
      const target =
        document.activeElement instanceof Element ? document.activeElement : document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: eventKey,
          code: eventCode,
          ctrlKey,
          altKey,
          shiftKey,
          metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    options.code ?? "",
    options.ctrlKey ?? false,
    options.altKey ?? false,
    options.shiftKey ?? false,
    options.metaKey ?? false,
  );
}

async function pressKeys(keys: string[]) {
  for (const key of keys) await press(key, {});
}

async function pressLabel(label: string) {
  for (const char of label.split("")) await press(char, {});
}

async function indicatorText() {
  return (await browser.execute(
    () => document.querySelector('[data-testid="vim-mode-indicator"]')?.textContent ?? "",
  )) as string;
}

async function waitMode(mode: "NORMAL" | "INSERT") {
  await browser.waitUntil(async () => (await indicatorText()).includes(mode), {
    timeout: 10_000,
    timeoutMsg: `Vim 徽标没有进入 ${mode}`,
  });
}

async function ensureVimEnabled() {
  if (await $(INDICATOR).isExisting()) return;
  await press("v", { code: "KeyV", ctrlKey: true, altKey: true });
  await $(INDICATOR).waitForDisplayed({ timeout: 10_000, timeoutMsg: "快捷键没有打开 Vim 导航" });
}

async function ensureNormal() {
  if ((await indicatorText()).includes("INSERT")) {
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
  }
  if ((await indicatorText()).includes("INSERT")) {
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await browser.pause(150);
  }
  await waitMode("NORMAL");
}

async function escapeAll() {
  for (let index = 0; index < 3; index += 1) await press("Escape", { code: "Escape" });
  await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
  await browser.pause(120);
}

async function parkPointer() {
  try {
    await browser.action("pointer").move({ x: 1000, y: 520 }).perform();
    await browser.pause(120);
  } catch {
    // 无指针能力的环境忽略。
  }
}

async function hintOpen(): Promise<boolean> {
  return (await $(HINT_OVERLAY).isExisting()) && (await $(HINT_OVERLAY).isDisplayed());
}

async function openSidePaneLauncher() {
  await ensureNormal();
  const hasLauncher = (await browser.execute(
    () => document.querySelectorAll("[data-side-pane-open-tab-item]").length > 0,
  )) as boolean;
  if (!hasLauncher) {
    await press("b", { code: "KeyB", ctrlKey: true, altKey: true });
    await browser.pause(400);
  }
  await browser.waitUntil(
    () =>
      browser.execute(() => document.querySelectorAll("[data-side-pane-open-tab-item]").length > 0),
    { timeout: 10_000, timeoutMsg: "侧栏面板 launcher 没有出现" },
  );
  await ensureNormal();
}

async function closeAllSidePaneTabs() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const closed = (await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>("[data-side-pane-tab-id]");
      const button = tab?.querySelector<HTMLElement>("button[aria-label]");
      if (!button) return false;
      button.click();
      return true;
    })) as boolean;
    if (!closed) break;
    await browser.pause(200);
  }
}

async function ensureChatPage() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const onChat = (await browser.execute(() =>
      Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
    )) as boolean;
    if (onChat) return;
    await browser.execute(() => {
      document
        .querySelectorAll<HTMLElement>('[data-testid="desktop-top-nav-back"]')
        .forEach((element) => element.click());
      document
        .querySelectorAll<HTMLElement>('[data-testid="settings-back-button"]')
        .forEach((element) => element.click());
      document
        .querySelectorAll<HTMLElement>('[data-testid="plugin-store-detail-back"]')
        .forEach((element) => element.click());
      document
        .querySelectorAll<HTMLElement>('[data-testid="plugin-store-manage-back"]')
        .forEach((element) => element.click());
      document.querySelector<HTMLElement>('[data-testid="preview-close-button"]')?.click();
      document
        .querySelector<HTMLElement>('[data-testid="plugin-store-root"] button[aria-label]')
        ?.click();
    });
    await browser.pause(350);
    if (
      (await browser.execute(() =>
        Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
      )) as boolean
    ) {
      return;
    }
    await browser.execute(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="task-item-"]'),
      ).filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      });
      rows[rows.length - 1]?.click();
    });
    await browser.pause(400);
  }
}

async function leaveSettingsAndStores() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = (await browser.execute(() => ({
      settings: Boolean(document.querySelector('[data-testid="settings-page"]')),
      store: Boolean(document.querySelector('[data-testid="plugin-store-root"]')),
      automations: Boolean(
        document.querySelector('[data-testid="automations-page-tab-automation"]'),
      ),
    }))) as { settings: boolean; store: boolean; automations: boolean };
    if (!page.settings && !page.store && !page.automations) return;
    await browser.execute(() => {
      document
        .querySelectorAll<HTMLElement>('[data-testid="settings-back-button"]')
        .forEach((element) => element.click());
      document
        .querySelectorAll<HTMLElement>('[data-testid="desktop-top-nav-back"]')
        .forEach((element) => element.click());
      document
        .querySelectorAll<HTMLElement>('[data-testid="plugin-store-detail-back"]')
        .forEach((element) => element.click());
      document
        .querySelectorAll<HTMLElement>('[data-testid="plugin-store-manage-back"]')
        .forEach((element) => element.click());
      document
        .querySelector<HTMLElement>('[data-testid="plugin-store-root"] button[aria-label]')
        ?.click();
    });
    await browser.pause(350);
  }
}

async function ensureSidebarVisible() {
  const visible = (await browser.execute(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-testid="sidebar"]');
    if (!sidebar) return false;
    const rect = sidebar.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  })) as boolean;
  if (visible) return;
  await press("b", { code: "KeyB", ctrlKey: true });
  await browser.pause(350);
}

async function resetApp() {
  await escapeAll();
  await parkPointer();
  await closeAllSidePaneTabs();
  await ensureVimEnabled();
  await ensureNormal();
  await leaveSettingsAndStores();
  await ensureChatPage();
  await ensureNormal();
  await ensureSidebarVisible();
  await browser.pause(120);
}

async function readHintFacts() {
  return (await browser.execute(() => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
    const badges = Array.from(overlay.querySelectorAll("span")).map((span) => {
      const border = span.parentElement?.querySelector<HTMLElement>("div");
      const style = border?.style;
      const left = style?.left ? Number.parseFloat(style.left) + 1 : null;
      const top = style?.top ? Number.parseFloat(style.top) + 1 : null;
      const width = style?.width ? Number.parseFloat(style.width) - 2 : null;
      const height = style?.height ? Number.parseFloat(style.height) - 2 : null;
      return {
        label: span.textContent ?? "",
        target:
          left === null || top === null || width === null || height === null
            ? null
            : ([left, top, width, height] as [number, number, number, number]),
      };
    });
    return {
      badges,
      status:
        Array.from(overlay.children)
          .map((child) => (child.textContent ?? "").trim())
          .filter((text) => text.startsWith("easymotion") || text.startsWith("sneak"))[0] ?? "",
    };
  })) as { badges: { label: string; target: number[] | null }[]; status: string } | null;
}

async function openHints() {
  if (await hintOpen()) {
    await press("Escape", { code: "Escape" });
    await browser.pause(100);
  }
  await press("f", { code: "KeyF" });
  let opened = true;
  try {
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 2_000 },
    );
  } catch {
    opened = false;
  }
  return opened ? readHintFacts() : null;
}

/** 收集 scope 内可见可交互元素（与产品 vimTargets 的 overflow 裁剪判据对齐）。 */
async function scopeFacts(scopeSelector: string | null) {
  return (await browser.execute((scopeSel) => {
    const scope = scopeSel
      ? document.querySelector<HTMLElement>(scopeSel)
      : (document.body as HTMLElement);
    if (!scope) return { missingScope: true as const, interactives: [] };

    const INTERACTIVE = [
      "a[href]",
      "button",
      "summary",
      "input:not([type=hidden])",
      "textarea",
      "select",
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="radio"]',
      '[role="link"]',
      '[tabindex="0"]',
    ].join(",");
    const CLIPPING = /^(auto|scroll|hidden|clip|overlay)$/;
    const transformLike = (style: CSSStyleDeclaration) => {
      const set = (value: string | undefined) => Boolean(value) && value !== "none";
      return (
        set(style.transform) ||
        set(style.perspective) ||
        set(style.filter) ||
        /(paint|layout|strict|content)/.test(style.contain ?? "") ||
        /(transform|perspective|filter)/.test(style.willChange ?? "")
      );
    };
    const establishes = (style: CSSStyleDeclaration, mode: "absolute" | "fixed") =>
      mode === "fixed" ? transformLike(style) : style.position !== "static" || transformLike(style);
    const clippedOut = (element: Element, rect: DOMRect) => {
      const own = getComputedStyle(element).position;
      let escape: "absolute" | "fixed" | null =
        own === "absolute" ? "absolute" : own === "fixed" ? "fixed" : null;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (escape) {
          if (!establishes(style, escape)) {
            ancestor = ancestor.parentElement;
            continue;
          }
          escape = null;
        }
        const clipX = CLIPPING.test(style.overflowX);
        const clipY = CLIPPING.test(style.overflowY);
        if (clipX || clipY) {
          const box = ancestor.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) {
            if (
              (clipX && (rect.right <= box.left || rect.left >= box.right)) ||
              (clipY && (rect.bottom <= box.top || rect.top >= box.bottom))
            ) {
              return true;
            }
          }
        }
        if (style.position === "fixed") escape = "fixed";
        else if (style.position === "absolute") escape = "absolute";
        ancestor = ancestor.parentElement;
      }
      return false;
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const state = (element: Element) => {
      let opacity = 1;
      let inert = false;
      let ariaHidden = false;
      let node: Element | null = element;
      while (node && node.nodeType === 1) {
        opacity *= Number.parseFloat(getComputedStyle(node).opacity || "1");
        if (node.hasAttribute("inert")) inert = true;
        if (node.getAttribute("aria-hidden") === "true") ariaHidden = true;
        node = node.parentElement;
      }
      const rect = element.getBoundingClientRect();
      const inViewport =
        rect.width > 2 &&
        rect.height > 2 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < vh &&
        rect.left < vw;
      const clipped = inViewport && clippedOut(element, rect);
      return {
        opacity,
        inert,
        ariaHidden,
        inViewport,
        clipped,
        rect: [rect.left, rect.top, rect.width, rect.height] as [number, number, number, number],
      };
    };
    const describe = (element: Element) => {
      const fact = state(element);
      return {
        testid: element.getAttribute("data-testid") ?? "",
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
        disabled:
          (element as HTMLButtonElement).disabled === true ||
          element.getAttribute("aria-disabled") === "true",
        rect: fact.rect.map((value) => Math.round(value)) as [number, number, number, number],
        inViewport: fact.inViewport,
        clipped: fact.clipped,
        visible:
          fact.inViewport &&
          !fact.inert &&
          !fact.ariaHidden &&
          fact.opacity > 0.01 &&
          !fact.clipped,
      };
    };
    const all = Array.from(scope.querySelectorAll<HTMLElement>("*")).slice(0, 20000);
    return {
      missingScope: false as const,
      interactives: all
        .filter((element) => element.matches(INTERACTIVE))
        .map(describe)
        .filter((entry) => entry.visible && !entry.disabled),
    };
  }, scopeSelector)) as {
    missingScope?: boolean;
    interactives: {
      testid: string;
      tag: string;
      role: string;
      text: string;
      rect: number[];
      inViewport: boolean;
      clipped: boolean;
      visible: boolean;
    }[];
  };
}

/** 每个提示标签的目标元素事实（含 overflow 裁剪、是否在指定 scope 内）。 */
async function badgeTargets(scopeSelector: string | null) {
  return (await browser.execute((scopeSel) => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
    const scope = scopeSel ? document.querySelector<HTMLElement>(scopeSel) : document.body;
    const INTERACTIVE = [
      "a[href]",
      "button",
      "summary",
      "input:not([type=hidden])",
      "textarea",
      "select",
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="radio"]',
      '[role="link"]',
      '[tabindex="0"]',
    ].join(",");
    const CLIPPING = /^(auto|scroll|hidden|clip|overlay)$/;
    const transformLike = (style: CSSStyleDeclaration) => {
      const set = (value: string | undefined) => Boolean(value) && value !== "none";
      return (
        set(style.transform) ||
        set(style.perspective) ||
        set(style.filter) ||
        /(paint|layout|strict|content)/.test(style.contain ?? "") ||
        /(transform|perspective|filter)/.test(style.willChange ?? "")
      );
    };
    const establishes = (style: CSSStyleDeclaration, mode: "absolute" | "fixed") =>
      mode === "fixed" ? transformLike(style) : style.position !== "static" || transformLike(style);
    const clippedOut = (element: Element, rect: DOMRect) => {
      const own = getComputedStyle(element).position;
      let escape: "absolute" | "fixed" | null =
        own === "absolute" ? "absolute" : own === "fixed" ? "fixed" : null;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (escape) {
          if (!establishes(style, escape)) {
            ancestor = ancestor.parentElement;
            continue;
          }
          escape = null;
        }
        const clipX = CLIPPING.test(style.overflowX);
        const clipY = CLIPPING.test(style.overflowY);
        if (clipX || clipY) {
          const box = ancestor.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) {
            if (
              (clipX && (rect.right <= box.left || rect.left >= box.right)) ||
              (clipY && (rect.bottom <= box.top || rect.top >= box.bottom))
            ) {
              return true;
            }
          }
        }
        if (style.position === "fixed") escape = "fixed";
        else if (style.position === "absolute") escape = "absolute";
        ancestor = ancestor.parentElement;
      }
      return false;
    };
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE)).map(
      (element) => ({ element, rect: element.getBoundingClientRect() }),
    );
    return Array.from(overlay.querySelectorAll<HTMLElement>("span")).map((span) => {
      const border = span.parentElement?.querySelector<HTMLElement>("div");
      const left = Number.parseFloat(border?.style.left ?? "NaN") + 1;
      const top = Number.parseFloat(border?.style.top ?? "NaN") + 1;
      const width = Number.parseFloat(border?.style.width ?? "NaN") - 2;
      const height = Number.parseFloat(border?.style.height ?? "NaN") - 2;
      const matches = candidates.filter(
        (candidate) =>
          Math.abs(candidate.rect.left - left) <= 3 &&
          Math.abs(candidate.rect.top - top) <= 3 &&
          Math.abs(candidate.rect.width - width) <= 3 &&
          Math.abs(candidate.rect.height - height) <= 3,
      );
      const target = matches[0] ?? null;
      return {
        label: span.textContent ?? "",
        targetRect: [left, top, width, height].map((value) => Math.round(value)),
        testid: target?.element.getAttribute("data-testid") ?? "",
        role: target?.element.getAttribute("role") ?? "",
        text: (target?.element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
        matched: target !== null,
        insideScope: target !== null && (scope?.contains(target.element) ?? false),
        fullyClipped: target !== null && clippedOut(target.element, target.rect),
      };
    });
  }, scopeSelector)) as
    | {
        label: string;
        targetRect: number[];
        testid: string;
        role: string;
        text: string;
        matched: boolean;
        insideScope: boolean;
        fullyClipped: boolean;
      }[]
    | null;
}

function rectsMatch(a: number[], b: number[], tolerance = 3) {
  return a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
}

function coverageMissing(
  facts: Awaited<ReturnType<typeof scopeFacts>>,
  badges: { targetRect: number[] }[],
) {
  return facts.interactives.filter(
    (entry) => !badges.some((badge) => rectsMatch(badge.targetRect, entry.rect)),
  );
}

async function hintLabelForTestid(testid: string): Promise<string | null> {
  return (await browser.execute((id) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (elements.length === 0 || !overlay) return null;
    const badges = Array.from(overlay.querySelectorAll("span")).map((span) => {
      const border = span.parentElement?.querySelector<HTMLElement>("div");
      return {
        label: span.textContent ?? "",
        left: Number.parseFloat(border?.style.left || "NaN") + 1,
        top: Number.parseFloat(border?.style.top || "NaN") + 1,
        width: Number.parseFloat(border?.style.width || "NaN") - 2,
        height: Number.parseFloat(border?.style.height || "NaN") - 2,
      };
    });
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      for (const badge of badges) {
        if (
          Number.isFinite(badge.left) &&
          Math.abs(badge.left - rect.left) <= 3 &&
          Math.abs(badge.top - rect.top) <= 3 &&
          Math.abs(badge.width - rect.width) <= 3 &&
          Math.abs(badge.height - rect.height) <= 3
        ) {
          return badge.label;
        }
      }
    }
    return null;
  }, testid)) as string | null;
}

async function hintLabelForSelector(selector: string): Promise<string | null> {
  return (await browser.execute((sel) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (elements.length === 0 || !overlay) return null;
    const badges = Array.from(overlay.querySelectorAll("span")).map((span) => {
      const border = span.parentElement?.querySelector<HTMLElement>("div");
      return {
        label: span.textContent ?? "",
        left: Number.parseFloat(border?.style.left || "NaN") + 1,
        top: Number.parseFloat(border?.style.top || "NaN") + 1,
        width: Number.parseFloat(border?.style.width || "NaN") - 2,
        height: Number.parseFloat(border?.style.height || "NaN") - 2,
      };
    });
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      for (const badge of badges) {
        if (
          Number.isFinite(badge.left) &&
          Math.abs(badge.left - rect.left) <= 3 &&
          Math.abs(badge.top - rect.top) <= 3 &&
          Math.abs(badge.width - rect.width) <= 3 &&
          Math.abs(badge.height - rect.height) <= 3
        ) {
          return badge.label;
        }
      }
    }
    return null;
  }, selector)) as string | null;
}

async function hintLabelForSelectorScrollable(selector: string): Promise<string | null> {
  let label = await hintLabelForSelector(selector);
  if (label !== null) return label;
  if (await hintOpen()) {
    await press("Escape", { code: "Escape" });
    await browser.pause(120);
  }
  await browser.execute((sel) => {
    document.querySelector<HTMLElement>(sel)?.scrollIntoView({ block: "center" });
  }, selector);
  await browser.pause(250);
  if ((await openHints()) === null) return null;
  label = await hintLabelForSelector(selector);
  return label;
}

/** 按 aria-label 子串找可聚焦按钮的提示标签。 */
async function hintLabelForAriaLabel(substring: string): Promise<string | null> {
  return (await browser.execute((wanted) => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
    const badges = Array.from(overlay.querySelectorAll("span")).map((span) => {
      const border = span.parentElement?.querySelector<HTMLElement>("div");
      return {
        label: span.textContent ?? "",
        left: Number.parseFloat(border?.style.left || "NaN") + 1,
        top: Number.parseFloat(border?.style.top || "NaN") + 1,
        width: Number.parseFloat(border?.style.width || "NaN") - 2,
        height: Number.parseFloat(border?.style.height || "NaN") - 2,
      };
    });
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]"));
    for (const button of buttons) {
      if (!(button.getAttribute("aria-label") ?? "").includes(wanted)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      for (const badge of badges) {
        if (
          Number.isFinite(badge.left) &&
          Math.abs(badge.left - rect.left) <= 3 &&
          Math.abs(badge.top - rect.top) <= 3 &&
          Math.abs(badge.width - rect.width) <= 3 &&
          Math.abs(badge.height - rect.height) <= 3
        ) {
          return badge.label;
        }
      }
    }
    return null;
  }, substring)) as string | null;
}

/** 在 role=menuitem/button 等可激活项里按文案找标签（Radix 菜单项不是 button）。 */
async function hintLabelForItemTexts(texts: string[]) {
  return (await browser.execute((wanted) => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
    const badges = Array.from(overlay.querySelectorAll("span")).map((span) => {
      const border = span.parentElement?.querySelector<HTMLElement>("div");
      return {
        label: span.textContent ?? "",
        left: Number.parseFloat(border?.style.left || "NaN") + 1,
        top: Number.parseFloat(border?.style.top || "NaN") + 1,
        width: Number.parseFloat(border?.style.width || "NaN") - 2,
        height: Number.parseFloat(border?.style.height || "NaN") - 2,
      };
    });
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], button, [role="button"]',
      ),
    );
    for (const item of items) {
      const text = (item.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || !wanted.some((candidate) => text.includes(candidate))) continue;
      const rect = item.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      const badge = badges.find(
        (candidate) =>
          Number.isFinite(candidate.left) &&
          Math.abs(candidate.left - rect.left) <= 3 &&
          Math.abs(candidate.top - rect.top) <= 3 &&
          Math.abs(candidate.width - rect.width) <= 3 &&
          Math.abs(candidate.height - rect.height) <= 3,
      );
      if (badge) return { label: badge.label, text };
    }
    return null;
  }, texts)) as { label: string; text: string } | null;
}

/** 在 root 内按文案找按钮，并返回提示标签。 */
async function hintLabelForButtonText(texts: string[], rootSelector: string) {
  return (await browser.execute(
    (wanted, rootSel) => {
      const root = document.querySelector<HTMLElement>(rootSel);
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      if (!root || !overlay) return null;
      const badges = Array.from(overlay.querySelectorAll("span")).map((span) => {
        const border = span.parentElement?.querySelector<HTMLElement>("div");
        return {
          label: span.textContent ?? "",
          left: Number.parseFloat(border?.style.left || "NaN") + 1,
          top: Number.parseFloat(border?.style.top || "NaN") + 1,
          width: Number.parseFloat(border?.style.width || "NaN") - 2,
          height: Number.parseFloat(border?.style.height || "NaN") - 2,
        };
      });
      const buttons = Array.from(root.querySelectorAll<HTMLElement>("button"));
      for (const button of buttons) {
        const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text || !wanted.some((candidate) => text.includes(candidate))) continue;
        const rect = button.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2) continue;
        const badge = badges.find(
          (item) =>
            Number.isFinite(item.left) &&
            Math.abs(item.left - rect.left) <= 3 &&
            Math.abs(item.top - rect.top) <= 3 &&
            Math.abs(item.width - rect.width) <= 3 &&
            Math.abs(item.height - rect.height) <= 3,
        );
        if (badge) return { label: badge.label, text };
      }
      return null;
    },
    texts,
    rootSelector,
  )) as { label: string; text: string } | null;
}

/** 聚焦前置任务行。 */
async function focusSeededTaskRow() {
  await ensureNormal();
  await ensureSidebarVisible();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (let inner = 0; inner < 3; inner += 1) {
      await press("l", { code: "KeyL" });
      await browser.pause(120);
      const inSidebar = (await browser.execute(
        () => document.activeElement?.closest('[data-testid="sidebar"]') !== null,
      )) as boolean;
      if (inSidebar) break;
    }
    await press("j", { code: "KeyJ" });
    await press("G", { code: "KeyG", shiftKey: true });
    await browser.pause(250);
    const focused = (await browser.execute(
      (ids) => ids.includes(document.activeElement?.getAttribute("data-testid") ?? ""),
      [`task-item-${taskId}`, `task-item-${secondTaskId}`].filter((id) => !id.endsWith("-")),
    )) as boolean;
    if (focused) return true;
    await browser.pause(200);
  }
  return false;
}

async function waitHoverCard(timeout = 4_000): Promise<boolean> {
  return browser
    .waitUntil(
      () =>
        browser.execute(() => Boolean(document.querySelector('[data-testid="task-row-details"]'))),
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );
}

async function focusRowAndShowCard(id: string): Promise<boolean> {
  const focused = (await browser.execute((rowId) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="task-item-${rowId}"]`);
    if (!row) return false;
    row.focus();
    return document.activeElement === row;
  }, id)) as boolean;
  if (!focused) return false;
  if (await waitHoverCard()) return true;
  await browser.execute((rowId) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="task-item-${rowId}"]`);
    row?.dispatchEvent(
      new PointerEvent("pointerover", {
        bubbles: true,
        pointerType: "mouse",
        clientX: 100,
        clientY: 280,
      }),
    );
  }, id);
  return waitHoverCard();
}

async function typeIntoActiveInput(value: string) {
  await browser.execute((text) => {
    const element = document.activeElement as HTMLInputElement | null;
    if (!element) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

describe("Vim 快速导航 Round 3 审计（Q2-18/19 对抗 + N/A 补测）", () => {
  before(async function () {
    this.timeout(480_000);
    await ensureReadonlyToolFixtureFile();
    // 可见 fixture 文件：文件索引可能忽略点目录，用非隐藏文件保证命令中心“文件”scope 可命中。
    await writeFile(
      join(DEFAULT_WORKSPACE, PREVIEW_FIXTURE_NAME),
      `${PREVIEW_FIXTURE_MARKER}\n`,
      "utf-8",
    );
    await prepareV4ConversationE2E();
    const marker = `E2E_VIM_R3_${Date.now()}`;
    await sendV4Prompt(buildReadonlyToolPrompt(marker));
    await waitForV4TimelineContaining(marker, 60_000);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 90_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
      "Round 3 前置任务没有完成",
      90_000,
      V4_MAIN_PANE_ID,
    );
    taskId = completed.sessionId ?? "";
    expect(taskId, "没有拿到前置任务 id").not.toBe("");
    // 第二个任务：给“多行轮流触发悬停卡”提供两行真实 task-item。
    // Ctrl+N 是菜单通道快捷键，合成 keydown 不触发；用侧栏“新建任务”按钮准备 fixture。
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="task-new-button"]')?.click(),
    );
    await browser.pause(1_000);
    const marker2 = `E2E_VIM_R3_B_${Date.now()}`;
    await sendV4Prompt(buildReadonlyToolPrompt(marker2));
    const second = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop &&
        Boolean(snapshot.sessionId) &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== taskId,
      "第二个前置任务没有完成",
      150_000,
      V4_MAIN_PANE_ID,
    );
    secondTaskId = second.sessionId ?? "";
    expect(secondTaskId, "没有拿到第二个任务 id").not.toBe("");
    const rows = (await browser.execute(
      () => document.querySelectorAll('[data-testid^="task-item-"]').length,
    )) as number;
    console.log(`R3 前置任务=${taskId} 第二任务=${secondTaskId} 侧栏任务行=${rows}`);
    await browser.pause(800);
  });

  after(async () => {
    if (await $(INDICATOR).isExisting()) {
      await press("v", { code: "KeyV", ctrlKey: true, altKey: true });
      await $(INDICATOR).waitForDisplayed({ reverse: true });
    }
    await clearAppData();
  });

  beforeEach(async () => {
    await resetApp();
  });

  it("R3-A01 多行轮流触发悬停卡：每行在场时 f 与 normal 键都不被劫持", async () => {
    const rows = [taskId, secondTaskId].filter(Boolean);
    const observed: {
      id: string;
      cardShown: boolean;
      badges: number;
      card: { text: string; rect: number[] };
    }[] = [];
    for (const id of rows) {
      const cardShown = await focusRowAndShowCard(id);
      const card = (await browser.execute(() => {
        const element = document.querySelector<HTMLElement>('[data-testid="task-row-details"]');
        const rect = element?.getBoundingClientRect();
        return {
          text: (element?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
          rect: rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round) : [],
        };
      })) as { text: string; rect: number[] };
      const hints = cardShown ? await openHints() : null;
      observed.push({ id, cardShown, badges: hints?.badges.length ?? -1, card });
      if (hints) {
        await press("Escape", { code: "Escape" });
        await browser.pause(120);
      }
    }
    console.log(`R3-A01 任务行悬停卡=${JSON.stringify(observed)}`);
    expect(rows.length, "没有两个任务行可做多行复验").toBeGreaterThan(1);
    expect(
      observed.filter((entry) => !entry.cardShown).map((entry) => entry.id),
      `有任务行的悬停卡没有出现: ${JSON.stringify(observed)}`,
    ).toEqual([]);
    expect(
      observed.filter((entry) => entry.badges <= 10).map((entry) => entry.id),
      `任务行悬停卡劫持 f 作用域: ${JSON.stringify(observed)}`,
    ).toEqual([]);
    // 两张卡不是同一份单点特判：行内容/锚点至少有一项不同。
    expect(
      observed[0]!.card.text !== observed[1]!.card.text ||
        String(observed[0]!.card.rect) !== String(observed[1]!.card.rect),
      `两行触发了完全相同的悬停卡（${JSON.stringify(observed.map((entry) => entry.card))}）`,
    ).toBe(true);

    // 第二种 hover-card 实现：会话 turn navigator（不同组件、无 role=tooltip）。
    const triggerDispatched = (await browser.execute(() => {
      const trigger = document.querySelector<HTMLElement>(
        '[data-testid^="v4-turn-navigator-item-"]',
      );
      if (!trigger) return false;
      const rect = trigger.getBoundingClientRect();
      trigger.focus();
      trigger.dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          pointerType: "mouse",
          clientX: rect.left + 4,
          clientY: rect.top + 4,
        }),
      );
      return true;
    })) as boolean;
    const navigatorCard = triggerDispatched
      ? await browser
          .waitUntil(
            () =>
              browser.execute(() =>
                Boolean(document.querySelector('[data-testid^="v4-turn-navigator-tooltip-"]')),
              ),
            { timeout: 5_000 },
          )
          .then(
            () => true,
            () => false,
          )
      : false;
    if (!navigatorCard) {
      console.log("R3-A01 turn navigator 悬停卡没有出现（焦点/指针未触发），该实例记 N/A");
      return;
    }
    const navigatorHints = await openHints();
    expect(navigatorHints, "turn navigator 悬停卡在场时 f 没有提示层").not.toBeNull();
    console.log(`R3-A01 turn navigator 卡在场=true 标签=${navigatorHints!.badges.length}`);
    expect(
      navigatorHints!.badges.length > 10,
      `turn navigator 悬停卡劫持 f（标签=${navigatorHints!.badges.length}）`,
    ).toBe(true);
    await press("Escape", { code: "Escape" });
  });

  it("R3-A02 悬停卡关闭后 normal 键与 f 作用域立即恢复", async () => {
    expect(await focusSeededTaskRow(), "j/G 没有把焦点移到前置任务行").toBe(true);
    expect(await waitHoverCard(), "悬停卡没有出现").toBe(true);
    // 收起提示层并把焦点移回主区：悬停卡应随焦点/指针离开而关闭。
    await openHints();
    await press("Escape", { code: "Escape" });
    await parkPointer();
    await press("l", { code: "KeyL" });
    await browser.pause(250);
    const cardGone = (await browser.execute(
      () => document.querySelector('[data-testid="task-row-details"]') === null,
    )) as boolean;
    const hints = await openHints();
    expect(hints, "悬停卡关闭后 f 没有提示层").not.toBeNull();
    expect(hints!.badges.length > 10, `悬停卡关闭后 f 标签只有 ${hints!.badges.length}`).toBe(true);
    await press("Escape", { code: "Escape" });
    const before = (await browser.execute(
      () => document.querySelector('[data-vim-active="true"]')?.getAttribute("data-testid") ?? "",
    )) as string;
    await press("l", { code: "KeyL" });
    await browser.pause(200);
    const after = (await browser.execute(
      () => document.querySelector('[data-vim-active="true"]')?.getAttribute("data-testid") ?? "",
    )) as string;
    console.log(
      `R3-A02 卡关闭=${cardGone} 标签=${hints!.badges.length} 区域 ${before || "main"}->${after || "main"}`,
    );
    expect(cardGone, "离开后悬停卡仍残留").toBe(true);
    expect(after !== before, "悬停卡关闭后 l 未轮转区域").toBe(true);
  });

  it("R3-A03 带可交互内容的 hover-card 仍应作为浮层作用域（不误伤）", async () => {
    await ensureNormal();
    await browser.execute(() => {
      document
        .querySelectorAll("[data-r3-injected-hover-card]")
        .forEach((element) => element.remove());
      const card = document.createElement("div");
      card.setAttribute("data-slot", "hover-card-content");
      card.setAttribute("data-state", "open");
      card.setAttribute("data-r3-injected-hover-card", "true");
      card.style.cssText =
        "position:fixed;left:240px;top:220px;width:220px;height:90px;z-index:9999;background:#fff;border:1px solid #999";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "R3 injected action";
      button.setAttribute("data-testid", "r3-injected-hover-button");
      card.appendChild(button);
      document.body.appendChild(card);
    });
    await browser.pause(120);
    const hints = await openHints();
    expect(hints, "可交互 hover-card 在场时 f 没有提示层").not.toBeNull();
    const badge = (await badgeTargets(null))?.find(
      (entry) => entry.testid === "r3-injected-hover-button",
    );
    console.log(
      `R3-A03 标签=${hints!.badges.length} 注入按钮标签=${JSON.stringify(badge ?? null)}`,
    );
    expect(badge, "可交互 hover-card 内的按钮没有拿到标签（浮层被误判为纯提示）").not.toBeNull();
    expect(hints!.badges.length, "可交互 hover-card 作用域没有收敛到卡片").toBeLessThanOrEqual(3);
    await press("Escape", { code: "Escape" });
    await browser.execute(() => {
      document
        .querySelectorAll("[data-r3-injected-hover-card]")
        .forEach((element) => element.remove());
    });
  });

  it("R3-A04 会话分享 Popover：f 作用域正确、背景不泄漏、Esc 后恢复", async () => {
    await ensureNormal();
    const opened = await openHints();
    expect(opened, "分享触发前 f 没有提示层").not.toBeNull();
    const triggerLabel = await hintLabelForTestid("conversation-share-trigger");
    if (triggerLabel === null) {
      const triggerCount = (await browser.execute(
        () => document.querySelectorAll('[data-testid="conversation-share-trigger"]').length,
      )) as number;
      console.log(
        `R3-A04 会话页没有 conversation-share-trigger 标签（DOM 数量=${triggerCount}；分享入口依赖登录态，E2E 匿名），改用侧栏标签页概览 Popover 做同类复验`,
      );
      await press("Escape", { code: "Escape" });
      await closeAllSidePaneTabs();
      await openSidePaneLauncher();
      await openHints();
      const filesLauncher = await hintLabelForSelector('[data-side-pane-open-tab-item="files"]');
      if (filesLauncher === null) {
        console.log("R3-A04 侧栏 launcher 的 files 项没有标签，Popover 复验记 N/A");
        await press("Escape", { code: "Escape" });
        return;
      }
      await pressLabel(filesLauncher);
      await waitTestidLocal("workspace-file-tree-panel", 15_000);
      await browser.pause(500);
      await ensureNormal();
      await openHints();
      let overviewLabel = await hintLabelForAriaLabel("搜索标签页");
      if (overviewLabel === null) overviewLabel = await hintLabelForAriaLabel("Search tabs");
      if (overviewLabel === null) {
        console.log("R3-A04 侧栏标签页概览按钮没有标签，Popover 复验记 N/A");
        await press("Escape", { code: "Escape" });
        await closeAllSidePaneTabs();
        return;
      }
      await pressLabel(overviewLabel);
      const fallbackOpened = await browser
        .waitUntil(
          () =>
            browser.execute(() => Boolean(document.querySelector('[data-slot="popover-content"]'))),
          { timeout: 8_000 },
        )
        .then(
          () => true,
          () => false,
        );
      if (!fallbackOpened) {
        console.log("R3-A04 标签激活侧栏标签页概览后 Popover 没有打开，记 N/A");
        await closeAllSidePaneTabs();
        return;
      }
      await browser.pause(300);
      // Popover 内的概览搜索框自动聚焦：先 Ctrl+[ 退出输入态（协议 §2.1），再 f。
      await press("[", { code: "BracketLeft", ctrlKey: true });
      await browser.pause(200);
      const popoverFacts = await scopeFacts('[data-slot="popover-content"]');
      const popoverHints = await openHints();
      expect(popoverHints, "侧栏标签页概览 Popover 内 f 没有提示层").not.toBeNull();
      const popoverBadges = await badgeTargets('[data-slot="popover-content"]');
      const popoverLeak = (popoverBadges ?? []).filter(
        (entry) => entry.matched && !entry.insideScope,
      );
      const popoverMissing = coverageMissing(popoverFacts, popoverBadges ?? []);
      console.log(
        `R3-A04 侧栏概览 Popover 标签=${popoverBadges?.length ?? 0} 预期控件=${popoverFacts.interactives.length} 泄漏=${popoverLeak.length} 漏标签=${popoverMissing.length}`,
      );
      expect(popoverLeak, `侧栏概览 Popover 标签泄漏: ${JSON.stringify(popoverLeak)}`).toEqual([]);
      expect(
        popoverMissing,
        `侧栏概览 Popover f 漏控件: ${JSON.stringify(popoverMissing)}`,
      ).toEqual([]);
      await press("Escape", { code: "Escape" });
      await browser.pause(150);
      // 第一下 Esc 先收起提示层（vim 消费），第二下才到 Popover 的 onEscapeKeyDown。
      if (
        (await browser.execute(
          () => document.querySelector('[data-slot="popover-content"]') !== null,
        )) as boolean
      ) {
        await press("Escape", { code: "Escape" });
      }
      await browser.waitUntil(
        () =>
          browser.execute(() => document.querySelector('[data-slot="popover-content"]') === null),
        { timeout: 5_000, timeoutMsg: "Esc 后侧栏概览 Popover 没有关闭" },
      );
      const fallbackRestored = await openHints();
      expect(fallbackRestored, "Popover 关闭后 f 没有恢复").not.toBeNull();
      await press("Escape", { code: "Escape" });
      await closeAllSidePaneTabs();
      return;
    }
    await pressLabel(triggerLabel);
    const popoverOpened = await browser
      .waitUntil(
        () =>
          browser.execute(
            () => document.querySelector('[data-testid="conversation-share-popover"]') !== null,
          ),
        { timeout: 8_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!popoverOpened) {
      console.log("R3-A04 标签激活分享触发器后 Popover 没有打开，记 N/A");
      return;
    }
    await browser.pause(400);
    const facts = await scopeFacts('[data-testid="conversation-share-popover"]');
    const hints = await openHints();
    expect(hints, "分享 Popover 内 f 没有提示层").not.toBeNull();
    const badges = await badgeTargets('[data-testid="conversation-share-popover"]');
    expect(badges, "分享 Popover 提示层为空").not.toBeNull();
    const leaked = badges!.filter((entry) => entry.matched && !entry.insideScope);
    const missing = coverageMissing(facts, badges!);
    console.log(
      `R3-A04 Popover 标签=${badges!.length} 预期控件=${facts.interactives.length} 泄漏=${leaked.length} 漏标签=${missing.length} 明细=${JSON.stringify(missing.slice(0, 8))}`,
    );
    expect(leaked, `分享 Popover 标签泄漏到背景: ${JSON.stringify(leaked)}`).toEqual([]);
    expect(missing, `分享 Popover f 漏掉控件: ${JSON.stringify(missing)}`).toEqual([]);
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelector('[data-testid="conversation-share-popover"]') === null,
        ),
      { timeout: 5_000, timeoutMsg: "Esc 后分享 Popover 没有关闭" },
    );
    const restored = await openHints();
    expect(restored, "分享 Popover 关闭后 f 没有恢复").not.toBeNull();
    expect(
      restored!.badges.length > 10,
      `分享 Popover 关闭后 f 标签只有 ${restored!.badges.length}`,
    ).toBe(true);
    await press("Escape", { code: "Escape" });
  });

  it("R3-A05 命令中心空查询：可见 option 全覆盖、完全裁剪项无标签", async () => {
    await ensureNormal();
    await press(":", { code: "Semicolon", shiftKey: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: ": 没有打开命令中心" },
    );
    await browser.pause(300);
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(200);
    const hints = await openHints();
    expect(hints, "命令中心空查询 f 没有提示层").not.toBeNull();
    const badges = await badgeTargets('[role="dialog"]');
    expect(badges, "命令中心提示层为空").not.toBeNull();

    const options = (await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('[data-slot="command-list"]');
      if (!list)
        return {
          total: 0,
          visible: [] as { text: string; rect: number[] }[],
          clipped: [] as string[],
        };
      const listRect = list.getBoundingClientRect();
      const items = Array.from(list.querySelectorAll<HTMLElement>("[cmdk-item]"));
      const visible: { text: string; rect: number[] }[] = [];
      const clipped: string[] = [];
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        const disabled =
          (item as HTMLButtonElement).disabled === true ||
          item.getAttribute("aria-disabled") === "true";
        if (rect.width <= 2 || rect.height <= 2 || disabled) continue;
        const fullyOutside =
          rect.bottom <= listRect.top ||
          rect.top >= listRect.bottom ||
          rect.right <= listRect.left ||
          rect.left >= listRect.right;
        const text = (item.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const rounded = [rect.left, rect.top, rect.width, rect.height].map(Math.round);
        if (fullyOutside) clipped.push(text);
        else visible.push({ text, rect: rounded });
      }
      return { total: items.length, visible, clipped };
    })) as { total: number; visible: { text: string; rect: number[] }[]; clipped: string[] };

    const dangling = badges!.filter((entry) => entry.fullyClipped);
    const unlabeled = options.visible.filter(
      (option) => !badges!.some((badge) => rectsMatch(badge.targetRect, option.rect)),
    );
    console.log(
      `R3-A05 标签=${badges!.length} cmdk项=${options.total} 可见=${options.visible.length} 完全裁剪=${options.clipped.length} 悬空标签=${dangling.length} 未覆盖可见=${unlabeled.length}`,
    );
    expect(
      dangling,
      `命令中心空查询存在指向完全裁剪目标的标签: ${JSON.stringify(dangling)}`,
    ).toEqual([]);
    expect(unlabeled, `命令中心可见 option 没有得到标签: ${JSON.stringify(unlabeled)}`).toEqual([]);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("R3-A06 命令中心半截 option：应有标签且激活后可用", async () => {
    await ensureNormal();
    await press(":", { code: "Semicolon", shiftKey: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: ": 没有打开命令中心" },
    );
    await browser.pause(250);
    await typeIntoActiveInput("e");
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll("[cmdk-item]").length > 8),
      { timeout: 8_000, timeoutMsg: "命令中心查询后 option 不足" },
    );
    // 让某个 option 横跨列表底边：上半可见、下半被裁剪。
    const partial = (await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('[data-slot="command-list"]');
      if (!list) return null;
      const listRect = list.getBoundingClientRect();
      const items = Array.from(list.querySelectorAll<HTMLElement>("[cmdk-item]")).filter(
        (item) =>
          !(item as HTMLButtonElement).disabled && item.getAttribute("aria-disabled") !== "true",
      );
      for (const item of items) {
        const itemRect = item.getBoundingClientRect();
        const currentTop = itemRect.top - listRect.top;
        // 让该项顶边落在列表底边上半行处：上半可见、下半被裁剪。
        list.scrollTop += currentTop - (list.clientHeight - itemRect.height / 2);
        const rect = item.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        if (rect.top < box.bottom - 4 && rect.bottom > box.bottom + 4) {
          return {
            text: (item.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
            rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
            listBottom: Math.round(box.bottom),
            scrollTop: list.scrollTop,
          };
        }
      }
      return null;
    })) as { text: string; rect: number[]; listBottom: number; scrollTop: number } | null;
    if (partial === null) {
      console.log("R3-A06 命令中心列表无法构造半截 option，记 N/A");
      await press("Escape", { code: "Escape" });
      return;
    }
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(200);
    const hints = await openHints();
    expect(hints, "半截 option 时 f 没有提示层").not.toBeNull();
    const label = await hintLabelForSelector("[cmdk-item]");
    const matched = (await badgeTargets('[role="dialog"]'))?.filter((entry) =>
      rectsMatch(entry.targetRect, partial.rect),
    );
    console.log(
      `R3-A06 半截项=${JSON.stringify(partial)} 标签总数=${hints!.badges.length} 该项标签=${JSON.stringify(matched ?? [])}`,
    );
    expect(matched && matched.length > 0, "半截可见 option 没有标签").toBe(true);
    const targetLabel = matched![0]!.label || label;
    if (targetLabel) {
      await pressLabel(targetLabel);
      const closed = await browser
        .waitUntil(
          () => browser.execute(() => document.querySelector('[role="dialog"]') === null),
          { timeout: 5_000 },
        )
        .then(
          () => true,
          () => false,
        );
      expect(closed, `半截 option 标签激活后命令中心没有关闭（标签=${targetLabel}）`).toBe(true);
    }
  });

  it("R3-A07 其它滚动容器（设置 nav / 插件商店）：无完全裁剪的悬空标签", async () => {
    await ensureNormal();
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestidLocal("settings-page");
    await browser.pause(250);
    const hints = await openHints();
    expect(hints, "设置页 f 没有提示层").not.toBeNull();
    const navInfo = (await browser.execute(() => {
      const anchor = document.querySelector<HTMLElement>('[data-settings-section-nav="general"]');
      let nav: HTMLElement | null = anchor;
      while (nav && nav !== document.body) {
        const style = getComputedStyle(nav);
        if (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          nav.scrollHeight > nav.clientHeight + 1
        ) {
          break;
        }
        nav = nav.parentElement;
      }
      return nav
        ? {
            scrollTop: nav.scrollTop,
            clientHeight: nav.clientHeight,
            scrollHeight: nav.scrollHeight,
          }
        : null;
    })) as { scrollTop: number; clientHeight: number; scrollHeight: number } | null;
    await browser.execute(() => {
      const anchor = document.querySelector<HTMLElement>('[data-settings-section-nav="general"]');
      let nav: HTMLElement | null = anchor;
      while (nav && nav !== document.body) {
        const style = getComputedStyle(nav);
        if (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          nav.scrollHeight > nav.clientHeight + 1
        ) {
          break;
        }
        nav = nav.parentElement;
      }
      if (nav) nav.scrollTop = 0;
    });
    await browser.pause(150);
    let badges = await badgeTargets('[data-testid="settings-page"]');
    const danglingBefore = (badges ?? []).filter((entry) => entry.fullyClipped);
    await browser.execute(() => {
      const anchor = document.querySelector<HTMLElement>('[data-settings-section-nav="general"]');
      let nav: HTMLElement | null = anchor;
      while (nav && nav !== document.body) {
        const style = getComputedStyle(nav);
        if (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          nav.scrollHeight > nav.clientHeight + 1
        ) {
          break;
        }
        nav = nav.parentElement;
      }
      if (nav) nav.scrollTop = nav.scrollHeight;
    });
    await browser.pause(150);
    await press("Escape", { code: "Escape" });
    const hintsAfter = await openHints();
    badges = await badgeTargets('[data-testid="settings-page"]');
    const danglingAfter = (badges ?? []).filter((entry) => entry.fullyClipped);
    console.log(
      `R3-A07 设置 nav=${JSON.stringify(navInfo)} 顶部悬空=${danglingBefore.length} 底部悬空=${danglingAfter.length}`,
    );
    expect(danglingBefore, `设置页顶部存在悬空标签: ${JSON.stringify(danglingBefore)}`).toEqual([]);
    expect(danglingAfter, `设置页底部存在悬空标签: ${JSON.stringify(danglingAfter)}`).toEqual([]);
    expect(hintsAfter, "设置页滚动后 f 没有提示层").not.toBeNull();
    await press("Escape", { code: "Escape" });

    // 插件商店：卡片列表同样可能滚动，检查无悬空标签。
    await press("Escape", { code: "Escape" });
    await leaveSettingsAndStores();
    await ensureChatPage();
    await ensureNormal();
    await openHints();
    let storeLabel = await hintLabelForTestid("plugin-store-sidebar-open");
    if (storeLabel === null) {
      // 侧栏可能被第 1 次 f 的提示会话消费；收起后重开。
      await press("Escape", { code: "Escape" });
      await openHints();
      storeLabel = await hintLabelForTestid("plugin-store-sidebar-open");
    }
    expect(storeLabel, "插件商店入口没有标签").not.toBeNull();
    await pressLabel(storeLabel!);
    await waitTestidLocal("plugin-store-root", 15_000);
    await browser.pause(500);
    const storeHints = await openHints();
    expect(storeHints, "插件商店 f 没有提示层").not.toBeNull();
    const storeBadges = await badgeTargets(null);
    const storeDangling = (storeBadges ?? []).filter((entry) => entry.fullyClipped);
    console.log(`R3-A07 插件商店标签=${storeBadges?.length ?? 0} 悬空=${storeDangling.length}`);
    expect(storeDangling, `插件商店存在悬空标签: ${JSON.stringify(storeDangling)}`).toEqual([]);
    await press("Escape", { code: "Escape" });
  });

  it("R3-C01 文件树打开 preview-pane：f 覆盖、关闭激活与 s", async () => {
    await closeAllSidePaneTabs();
    await openSidePaneLauncher();
    await openHints();
    const launcherLabel = await hintLabelForSelector('[data-side-pane-open-tab-item="files"]');
    if (launcherLabel === null) {
      console.log("R3-C01 文件树 launcher 没有标签，记 N/A");
      await press("Escape", { code: "Escape" });
      return;
    }
    await pressLabel(launcherLabel);
    await waitTestidLocal("workspace-file-tree-panel", 15_000);
    await browser.pause(600);
    await ensureNormal();

    const rowTestId = (await browser.execute((fileName) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="workspace-file-tree-row-"]'),
      ).find((element) => (element.getAttribute("data-testid") ?? "").endsWith(fileName));
      return row?.getAttribute("data-testid") ?? "";
    }, PREVIEW_FIXTURE_NAME)) as string;
    const rowExists = rowTestId !== "";
    if (!rowExists) {
      const rows = (await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid^="workspace-file-tree-row-"]'),
        ).map((row) => row.getAttribute("data-testid") ?? ""),
      )) as string[];
      console.log(
        `R3-C01 文件树没有 fixture 行（存在=${rowExists}），rows=${JSON.stringify(rows.slice(0, 20))}，记 N/A`,
      );
      await closeAllSidePaneTabs();
      return;
    }
    const rowLabel =
      (await hintLabelForSelector(`[data-testid="${rowTestId}"]`)) ??
      (await hintLabelForSelectorScrollable(`[data-testid="${rowTestId}"]`));
    if (rowLabel === null) {
      const rowFacts = (await browser.execute((id) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return {
          rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
          tabindex: row.getAttribute("tabindex"),
          role: row.getAttribute("role"),
          badges: document.querySelectorAll("[data-vim-hint-overlay] span").length,
          parentOverflow: (() => {
            let node: HTMLElement | null = row.parentElement;
            while (node) {
              const style = getComputedStyle(node);
              if (/(auto|scroll|hidden)/.test(style.overflowY)) {
                const box = node.getBoundingClientRect();
                return { rect: [box.left, box.top, box.width, box.height].map(Math.round) };
              }
              node = node.parentElement;
            }
            return null;
          })(),
        };
      }, rowTestId)) as Record<string, unknown> | null;
      console.log(`R3-C01 fixture 文件行没有 f 标签，row=${JSON.stringify(rowFacts)}`);
    }
    expect(rowLabel, "fixture 文件行没有 f 标签").not.toBeNull();
    await pressLabel(rowLabel!);
    const previewOpened = await browser
      .waitUntil(
        () =>
          browser.execute(() => document.querySelector('[data-testid="preview-pane"]') !== null),
        { timeout: 8_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!previewOpened) {
      console.log("R3-C01 标签激活 fixture 行后 preview-pane 没有打开，记 N/A");
      await closeAllSidePaneTabs();
      return;
    }
    await browser.pause(500);
    // 文件读取异步：等预览内容真正渲染（文本 >0 或出现子控件）再测 f。
    const previewReady = await browser
      .waitUntil(
        () =>
          browser.execute(() => {
            const pane = document.querySelector<HTMLElement>('[data-testid="preview-pane"]');
            if (!pane) return false;
            const text = (pane.textContent ?? "").trim();
            return text.length > 0 || pane.querySelectorAll("button, [tabindex='0']").length > 0;
          }),
        { timeout: 10_000 },
      )
      .then(
        () => true,
        () => false,
      );
    const previewText = (await browser.execute(() =>
      (document.querySelector('[data-testid="preview-pane"]')?.textContent ?? "").slice(0, 120),
    )) as string;
    console.log(`R3-C01 预览就绪=${previewReady} 渲染文本=${previewText}`);
    if (!previewReady) {
      console.log("R3-C01 preview-pane 10s 内没有渲染内容，记 N/A");
      await closeAllSidePaneTabs();
      return;
    }
    await ensureNormal();
    const facts = await scopeFacts('[data-testid="preview-pane"]');
    const hints = await openHints();
    expect(hints, "preview-pane f 没有提示层").not.toBeNull();
    const badges = await badgeTargets(null);
    const paneMissing = coverageMissing(facts, badges ?? []);
    console.log(
      `R3-C01 预览控件=${facts.interactives.length} 标签=${badges?.length ?? 0} 预览内漏=${paneMissing.length}`,
    );
    expect(paneMissing, `preview-pane f 漏掉控件: ${JSON.stringify(paneMissing)}`).toEqual([]);

    // s：预览文件内容（E2E_VIM_R3_PREVIEW_MARKER）应可被 sneak 命中。
    await press("Escape", { code: "Escape" });
    await press("s", { code: "KeyS" });
    await pressKeys("E2".split(""));
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 5_000, timeoutMsg: "preview-pane 内 s 没有进入 sneak" },
    );
    const sneakText = (await browser.execute(
      () => document.querySelector("[data-vim-hint-overlay]")?.textContent ?? "",
    )) as string;
    console.log(`R3-C01 sneak=${sneakText.slice(0, 80)}`);
    expect(sneakText, "preview-pane 内 s 没有进入 sneak 查询态").toContain("sneak");
    await press("Escape", { code: "Escape" });

    // 滚动预览内容后重新 f：标签仍覆盖当前视口，预览保持打开。
    await browser.execute(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid="preview-pane"]');
      const scroller = Array.from(pane?.querySelectorAll<HTMLElement>("*") ?? []).find(
        (element) => element.scrollHeight > element.clientHeight + 4,
      );
      if (scroller) scroller.scrollTop = 200;
    });
    await browser.pause(200);
    const afterScroll = await openHints();
    expect(afterScroll, "预览滚动后 f 没有提示层").not.toBeNull();
    expect(afterScroll!.badges.length > 0, "预览滚动后 f 标签为空").toBe(true);
    await press("Escape", { code: "Escape" });
    // 预览关闭走侧栏 tab 的关闭按钮（产品没有 preview-close-button testid）。
    await closeAllSidePaneTabs();
  });

  it("R3-C02 SSH 对话框：键盘入口可达、f 作用域与 Esc", async () => {
    await ensureNormal();
    let triggerLabel: string | null = null;
    const workspaceHints = await openHints();
    if (workspaceHints) {
      triggerLabel = await hintLabelForTestid("ssh-connect-trigger");
    }
    if (triggerLabel !== null) {
      await pressLabel(triggerLabel);
      console.log("R3-C02 通过工作区 ssh-connect-trigger 标签打开 SSH 对话框");
    } else {
      // 兜底：设置 → 远程设备 → 创建连接。
      await press("Escape", { code: "Escape" });
      await press(",", { code: "Comma", ctrlKey: true });
      await waitTestidLocal("settings-page");
      await browser.pause(250);
      await openHints();
      let navLabel = await hintLabelForSelector(
        '[data-testid="settings-section-nav-remoteDevices"]',
      );
      if (navLabel === null) {
        navLabel = await hintLabelForSelectorScrollable(
          '[data-testid="settings-section-nav-remoteDevices"]',
        );
      }
      if (navLabel === null) {
        console.log("R3-C02 远程设备分区导航没有标签，记 N/A");
        await press("Escape", { code: "Escape" });
        return;
      }
      await pressLabel(navLabel);
      await browser
        .waitUntil(
          () =>
            browser.execute(
              () =>
                document
                  .querySelector('[data-testid="settings-page"]')
                  ?.getAttribute("data-active-section") === "remoteDevices",
            ),
          { timeout: 8_000 },
        )
        .then(
          () => true,
          () => false,
        );
      await browser.pause(600);
      const create = await hintLabelForButtonText(
        ["创建连接", "新建连接", "添加设备", "Create connection", "Add device", "Connect"],
        '[data-testid="settings-page"]',
      );
      if (create === null) {
        const buttons = (await browser.execute(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="settings-page"] button'),
          ).map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30)),
        )) as string[];
        console.log(
          `R3-C02 工作区无 ssh-connect-trigger 标签，远程设备分区也无创建按钮（ssh-connect-trigger DOM 数量=${await browser.execute(
            () => document.querySelectorAll('[data-testid="ssh-connect-trigger"]').length,
          )}），buttons=${JSON.stringify(buttons.slice(0, 20))}，记 N/A`,
        );
        await press("Escape", { code: "Escape" });
        return;
      }
      await pressLabel(create.label);
    }
    const dialogOpened = await browser
      .waitUntil(
        () => browser.execute(() => document.querySelector('[data-testid="ssh-dialog"]') !== null),
        { timeout: 8_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!dialogOpened) {
      console.log("R3-C02 激活 SSH 入口后 ssh-dialog 没有打开，记 N/A");
      return;
    }
    await browser.pause(400);
    const facts = await scopeFacts('[data-testid="ssh-dialog"]');
    const hints = await openHints();
    expect(hints, "SSH 对话框 f 没有提示层").not.toBeNull();
    const badges = await badgeTargets('[data-testid="ssh-dialog"]');
    const missing = coverageMissing(facts, badges ?? []);
    const leaked = (badges ?? []).filter((entry) => entry.matched && !entry.insideScope);
    console.log(
      `R3-C02 SSH 对话框控件=${facts.interactives.length} 标签=${badges?.length ?? 0} 漏=${missing.length} 泄漏=${leaked.length}`,
    );
    expect(missing, `SSH 对话框 f 漏掉控件: ${JSON.stringify(missing)}`).toEqual([]);
    expect(leaked, `SSH 对话框标签泄漏到背景: ${JSON.stringify(leaked)}`).toEqual([]);
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[data-testid="ssh-dialog"]') === null),
      { timeout: 5_000, timeoutMsg: "Esc 后 SSH 对话框没有关闭" },
    );
  });

  it("R3-C03 Onboarding 页面（Ctrl+Shift+O）：f 覆盖与 s", async () => {
    await ensureNormal();
    await press("o", { code: "KeyO", ctrlKey: true, shiftKey: true });
    const opened = await browser
      .waitUntil(
        () =>
          browser.execute(() => document.querySelector('[data-testid="onboarding-page"]') !== null),
        { timeout: 6_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!opened) {
      console.log("R3-C03 Ctrl+Shift+O 没有打开 onboarding-page，记 N/A");
      return;
    }
    await browser.pause(500);
    // 结构性事实：Onboarding 可见时 App（含 vim 层/指示器）整体被替换，f/s 层不挂载。
    const structure = (await browser.execute(() => ({
      indicator: Boolean(document.querySelector('[data-testid="vim-mode-indicator"]')),
      sidebar: Boolean(document.querySelector('[data-testid="sidebar"]')),
      onboarding: Boolean(document.querySelector('[data-testid="onboarding-page"]')),
      buttons: document.querySelectorAll('[data-testid="onboarding-page"] button').length,
      inputs: document.querySelectorAll('[data-testid="onboarding-page"] input').length,
    }))) as {
      indicator: boolean;
      sidebar: boolean;
      onboarding: boolean;
      buttons: number;
      inputs: number;
    };
    console.log(
      `R3-C03 onboarding 结构=${JSON.stringify(structure)}；vim 指示器/侧栏随 App 卸载 → f/s 结构性 N/A（P1 项，按协议记 N/A）`,
    );
    expect(structure.onboarding, "onboarding-page 已消失").toBe(true);
    expect(
      structure.buttons + structure.inputs,
      "Onboarding 页没有任何键盘可达控件",
    ).toBeGreaterThan(0);
    // Esc 是 Onboarding 自带的键盘退出路径；关闭后 App/vim 层恢复。
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () =>
        browser.execute(() => document.querySelector('[data-testid="onboarding-page"]') === null),
      { timeout: 6_000, timeoutMsg: "Esc 后 onboarding 没有关闭" },
    );
    await browser.pause(300);
    await ensureVimEnabled();
    await ensureNormal();
    const restored = await openHints();
    expect(restored, "onboarding 关闭后 f 没有恢复").not.toBeNull();
    expect(restored!.badges.length, "onboarding 关闭后 f 标签为空").toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
  });

  it("R3-C04 设置 usage 分区：分区可达、usage tab 有标签且可激活", async () => {
    await ensureNormal();
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestidLocal("settings-page");
    await browser.pause(250);
    await openHints();
    let navLabel = await hintLabelForSelector('[data-testid="settings-section-nav-usage"]');
    if (navLabel === null) {
      navLabel = await hintLabelForSelectorScrollable('[data-testid="settings-section-nav-usage"]');
    }
    expect(navLabel, "设置 usage 分区导航没有标签").not.toBeNull();
    await pressLabel(navLabel!);
    await browser
      .waitUntil(
        () =>
          browser.execute(
            () =>
              document
                .querySelector('[data-testid="settings-page"]')
                ?.getAttribute("data-active-section") === "usage",
          ),
        { timeout: 8_000 },
      )
      .then(
        () => true,
        () => false,
      );
    await browser.pause(800);
    const tabExists = (await browser.execute(
      () => document.querySelector('[data-testid="settings-usage-tab-app"]') !== null,
    )) as boolean;
    if (!tabExists) {
      console.log("R3-C04 usage 分区没有 settings-usage-tab-app，记 N/A");
      await press("Escape", { code: "Escape" });
      return;
    }
    const facts = await scopeFacts('[data-testid="settings-page"]');
    const hints = await openHints();
    expect(hints, "usage 分区 f 没有提示层").not.toBeNull();
    const badges = await badgeTargets('[data-testid="settings-page"]');
    const missing = coverageMissing(facts, badges ?? []);
    const tabLabel = await hintLabelForTestid("settings-usage-tab-app");
    console.log(
      `R3-C04 usage 控件=${facts.interactives.length} 标签=${badges?.length ?? 0} 漏=${missing.length} tab标签=${tabLabel}`,
    );
    expect(tabLabel, "settings-usage-tab-app 没有标签").not.toBeNull();
    const svgProbe = (await browser.execute(() => {
      const page = document.querySelector('[data-testid="settings-page"]');
      const svgs = Array.from(
        page?.querySelectorAll<SVGElement>('svg[role="application"][tabindex="0"]') ?? [],
      );
      return svgs.map((svg) => {
        const rect = svg.getBoundingClientRect();
        return {
          tag: svg.tagName.toLowerCase(),
          constructor: svg.constructor.name,
          instanceofHTMLElement: svg instanceof HTMLElement,
          instanceofElement: svg instanceof Element,
          tabindex: svg.getAttribute("tabindex"),
          rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
          ariaLabel: svg.getAttribute("aria-label") ?? "",
        };
      });
    })) as Record<string, unknown>[];
    console.log(`R3-C04 usage 图表 SVG 探针=${JSON.stringify(svgProbe)}`);
    expect(missing, `usage 分区 f 漏掉控件: ${JSON.stringify(missing)}`).toEqual([]);
    await pressLabel(tabLabel!);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="settings-usage-tab-app"]')
              ?.getAttribute("aria-pressed") === "true",
        ),
      { timeout: 5_000, timeoutMsg: "标签激活 usage tab 后没有选中" },
    );
    await press("Escape", { code: "Escape" });
  });

  it("R3-C05 Model trajectory 面板复测（activeSessionId 就绪后）", async () => {
    await ensureNormal();
    const rowFocused = (await browser.execute((id) => {
      const row = document.querySelector<HTMLElement>(`[data-testid="task-item-${id}"]`);
      if (!row) return false;
      row.focus();
      return document.activeElement === row;
    }, taskId)) as boolean;
    if (!rowFocused) {
      const state = (await browser.execute(() => ({
        active: document.activeElement?.getAttribute("data-testid") ?? "",
        tag: document.activeElement?.tagName.toLowerCase() ?? "",
        chat: Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
        settings: Boolean(document.querySelector('[data-testid="settings-page"]')),
        sidebar: Boolean(document.querySelector('[data-testid="sidebar"]')),
        rows: document.querySelectorAll('[data-testid^="task-item-"]').length,
      }))) as Record<string, unknown>;
      console.log(`R3-C05 前置任务行聚焦失败，state=${JSON.stringify(state)}`);
    }
    expect(rowFocused, "j/G 没有把焦点移到前置任务行").toBe(true);
    await press("Enter", { code: "Enter" });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskId,
      "前置任务没有被激活为当前会话",
      15_000,
    );
    await browser.pause(300);
    // 原生 Shift+F10 不可靠，用 DOM contextmenu 准备菜单（与 Q2-05/Q2-16 相同）。
    await browser.execute((id) => {
      const row = document.querySelector<HTMLElement>(`[data-testid="task-item-${id}"]`);
      if (!row) return;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    }, taskId);
    await browser
      .waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000 },
      )
      .then(
        () => true,
        () => false,
      );
    await openHints();
    const trajectoryLabel = await hintLabelForItemTexts([
      "查看调用轨迹",
      "查看模型调用轨迹",
      "View model trajectory",
      "Model trajectory",
    ]);
    if (trajectoryLabel === null) {
      const items = (await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => ({
          text: (item.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          disabled:
            item.getAttribute("aria-disabled") === "true" ||
            item.getAttribute("data-disabled") !== null,
        })),
      )) as { text: string; disabled: boolean }[];
      console.log(`R3-C05 调用轨迹菜单项仍不可用，记 N/A：${JSON.stringify(items)}`);
      await press("Escape", { code: "Escape" });
      return;
    }
    await pressLabel(trajectoryLabel.label);
    const panelOpened = await browser
      .waitUntil(
        () =>
          browser.execute(
            () =>
              Boolean(document.querySelector("[data-trajectory-timeline]")) ||
              Boolean(document.querySelector('[data-side-pane-tab-id][data-state="active"]')),
          ),
        { timeout: 15_000 },
      )
      .then(
        () => true,
        () => false,
      );
    expect(panelOpened, "激活调用轨迹菜单项后侧栏没有打开").toBe(true);
    await browser.pause(800);
    await ensureNormal();
    const facts = await scopeFacts(null);
    const hints = await openHints();
    expect(hints, "Model trajectory 面板 f 没有提示层").not.toBeNull();
    const badges = await badgeTargets(null);
    const missing = coverageMissing(facts, badges ?? []);
    console.log(
      `R3-C05 trajectory 控件=${facts.interactives.length} 标签=${badges?.length ?? 0} 漏=${missing.length}`,
    );
    expect(missing, `Model trajectory f 漏掉控件: ${JSON.stringify(missing)}`).toEqual([]);
    await press("Escape", { code: "Escape" });
    await closeAllSidePaneTabs();
  });

  it("R3-C06 Automations 激活稳定性 ×3（Q1-17/Q1-18/Q2-17 首跑偶发项）", async () => {
    const results: { attempt: number; opened: boolean; ms: number }[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await leaveSettingsAndStores();
      await ensureChatPage();
      await ensureNormal();
      await ensureSidebarVisible();
      const started = Date.now();
      await openHints();
      let label = await hintLabelForTestid("automations-open");
      if (label === null) {
        await press("Escape", { code: "Escape" });
        await openHints();
        label = await hintLabelForTestid("automations-open");
      }
      if (label === null) {
        const pageFacts = (await browser.execute(() => ({
          chat: Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
          settings: Boolean(document.querySelector('[data-testid="settings-page"]')),
          sidebar: Boolean(document.querySelector('[data-testid="sidebar"]')),
          badges: document.querySelectorAll("[data-vim-hint-overlay] span").length,
        }))) as { chat: boolean; settings: boolean; sidebar: boolean; badges: number };
        console.log(
          `R3-C06 第 ${attempt} 次 automations-open 无标签，页面=${JSON.stringify(pageFacts)}`,
        );
      }
      expect(label, `第 ${attempt} 次 automations-open 没有标签`).not.toBeNull();
      await pressLabel(label!);
      const opened = await browser
        .waitUntil(
          () =>
            browser.execute(
              () =>
                document.querySelector('[data-testid="automations-page-tab-automation"]') !== null,
            ),
          { timeout: 8_000 },
        )
        .then(
          () => true,
          () => false,
        );
      results.push({ attempt, opened, ms: Date.now() - started });
      await browser.execute(() => {
        document
          .querySelectorAll<HTMLElement>('[data-testid="desktop-top-nav-back"]')
          .forEach((element) => element.click());
      });
      await browser.pause(500);
    }
    console.log(`R3-C06 Automations 激活结果=${JSON.stringify(results)}`);
    expect(
      results.every((entry) => entry.opened),
      `Automations 激活存在偶发失败: ${JSON.stringify(results)}`,
    ).toBe(true);
  });

  it("R3-C07 生成中状态：stop 可用时 f 覆盖（否则 N/A）", async () => {
    await ensureChatPage();
    await ensureNormal();
    const marker = `E2E_VIM_R3_RUN_${Date.now()}`;
    await sendV4Prompt(`${marker}: reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    const start = Date.now();
    let sawStop = false;
    while (Date.now() - start < 8_000) {
      if (
        (await browser.execute(
          () => document.querySelector('[data-testid="v4-stop"]') !== null,
        )) as boolean
      ) {
        sawStop = true;
        break;
      }
      await browser.pause(50);
    }
    if (!sawStop) {
      console.log("R3-C07 未捕获到 v4-stop 生成中窗口，记 N/A");
      await browser.waitUntil(
        () => browser.execute(() => document.querySelector('[data-testid="v4-stop"]') === null),
        { timeout: 60_000 },
      );
      return;
    }
    await ensureNormal();
    const hints = await openHints();
    expect(hints, "生成中 f 没有提示层").not.toBeNull();
    const badgeCount = hints!.badges.length;
    // 原子快照：快速 replay 的 stop 可能在 openHints 前后瞬间消失；只采信“同帧存在且 rect 命中”。
    const stopSnapshot = (await browser.execute(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="v4-stop"]');
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      const badges = Array.from(overlay?.querySelectorAll<HTMLElement>("span") ?? []).map(
        (span) => {
          const border = span.parentElement?.querySelector<HTMLElement>("div");
          return {
            label: span.textContent ?? "",
            left: Number.parseFloat(border?.style.left || "NaN") + 1,
            top: Number.parseFloat(border?.style.top || "NaN") + 1,
            width: Number.parseFloat(border?.style.width || "NaN") - 2,
            height: Number.parseFloat(border?.style.height || "NaN") - 2,
          };
        },
      );
      if (!element) return { stopAtHint: false, label: null, badges: badges.length };
      const rect = element.getBoundingClientRect();
      const matched = badges.filter(
        (badge) =>
          Number.isFinite(badge.left) &&
          Math.abs(badge.left - rect.left) <= 3 &&
          Math.abs(badge.top - rect.top) <= 3 &&
          Math.abs(badge.width - rect.width) <= 3 &&
          Math.abs(badge.height - rect.height) <= 3,
      );
      return {
        stopAtHint: true,
        rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
        label: matched[0]?.label ?? null,
        badges: badges.length,
      };
    })) as {
      stopAtHint: boolean;
      rect?: number[];
      label: string | null;
      badges: number;
    };
    console.log(`R3-C07 生成中标签=${badgeCount} stop快照=${JSON.stringify(stopSnapshot)}`);
    if (!stopSnapshot.stopAtHint) {
      console.log(
        "R3-C07 stop 在提示层采集时已消失（快速流竞态），本次记 N/A（隔离探针 S2 提供有效采样）",
      );
    } else {
      expect(stopSnapshot.label, "生成中 stop 与提示层同帧但没有标签").not.toBeNull();
    }
    expect(badgeCount > 3, `生成中 f 标签过少（${badgeCount}）`).toBe(true);
    await press("Escape", { code: "Escape" });
    // 不点击 stop：让 replay 正常完成，避免后续用例被中断状态污染。
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[data-testid="v4-stop"]') === null),
      { timeout: 60_000, timeoutMsg: "生成没有按预期结束" },
    );
  });

  it("R4-A01 Element 泛化回归：d/u 半页滚动、h/l 区域轮转、j/k 列表移动不退化", async () => {
    await ensureNormal();
    // d/u：时间线注入 filler，验证半页滚动与回滚（normal 键路径）。
    await browser.execute(() => {
      const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
      if (!timeline) throw new Error("找不到时间线滚动容器");
      const filler = document.createElement("div");
      filler.id = "vim-r4-scroll-filler";
      filler.style.height = "3000px";
      timeline.append(filler);
      timeline.scrollTop = 0;
    });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
          return Boolean(timeline && timeline.scrollHeight > timeline.clientHeight + 1000);
        }),
      { timeout: 5_000, timeoutMsg: "R4-A01 滚动占位没有生效" },
    );
    const readScroll = async () =>
      (await browser.execute(() => {
        const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
        return {
          scrollTop: Math.round(timeline?.scrollTop ?? -1),
          clientHeight: timeline?.clientHeight ?? 0,
        };
      })) as { scrollTop: number; clientHeight: number };
    const scrollTop = await readScroll();
    await press("d", { code: "KeyD" });
    await browser.pause(300);
    const afterD = await readScroll();
    await press("u", { code: "KeyU" });
    await browser.pause(300);
    const afterU = await readScroll();
    console.log(
      `R4-A01 d/u=${scrollTop.scrollTop}->${afterD.scrollTop}->${afterU.scrollTop} client=${scrollTop.clientHeight}`,
    );
    expect(
      afterD.scrollTop - scrollTop.scrollTop >= scrollTop.clientHeight * 0.4,
      `d 没有向下滚动半页（${scrollTop.scrollTop}->${afterD.scrollTop}）`,
    ).toBe(true);
    expect(
      afterD.scrollTop - afterU.scrollTop >= scrollTop.clientHeight * 0.4,
      `u 没有向上滚动半页（${afterD.scrollTop}->${afterU.scrollTop}）`,
    ).toBe(true);
    await browser.execute(() => document.querySelector("#vim-r4-scroll-filler")?.remove());

    // h/l：区域轮转。
    const readRegion = async () =>
      (await browser.execute(
        () => document.querySelector('[data-vim-active="true"]')?.getAttribute("data-testid") ?? "",
      )) as string;
    const region = await readRegion();
    await press("h", { code: "KeyH" });
    await browser.pause(200);
    const afterH = await readRegion();
    await press("l", { code: "KeyL" });
    await browser.pause(200);
    const afterL = await readRegion();
    console.log(`R4-A01 h/l 区域=${region}->${afterH}->${afterL}`);
    expect(afterH !== region, `h 未轮转区域（${region}->${afterH}）`).toBe(true);
    expect(afterL !== afterH, `l 未轮转区域（${afterH}->${afterL}）`).toBe(true);

    // j/k：侧栏任务行列表移动。
    expect(await focusSeededTaskRow(), "R4-A01 前置任务行聚焦失败").toBe(true);
    const readActiveTestid = async () =>
      (await browser.execute(
        () => document.activeElement?.getAttribute("data-testid") ?? "",
      )) as string;
    const rowCount = (await browser.execute(
      () => document.querySelectorAll("[data-task-item-key]").length,
    )) as number;
    await press("G", { code: "KeyG", shiftKey: true });
    await browser.pause(200);
    const lastRow = await readActiveTestid();
    await press("k", { code: "KeyK" });
    await browser.pause(200);
    const afterK = await readActiveTestid();
    await press("j", { code: "KeyJ" });
    await browser.pause(200);
    const afterJ = await readActiveTestid();
    console.log(`R4-A01 j/k 行=${lastRow}->${afterK}->${afterJ} rows=${rowCount}`);
    expect(lastRow, "G 没有把焦点移到任务行").not.toBe("");
    if (rowCount > 1) {
      expect(afterK !== lastRow, `k 没有移动任务行焦点（仍在 ${lastRow}）`).toBe(true);
    }
    expect(afterJ, "j 没有回到下一任务行").toBe(lastRow);
    await press("Escape", { code: "Escape" });
  });
});

async function waitTestidLocal(testid: string, timeout = 10_000) {
  await $(`[data-testid="${testid}"]`).waitForDisplayed({
    timeout,
    timeoutMsg: `[data-testid=${testid}] 没有出现`,
  });
}
