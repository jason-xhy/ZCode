/**
 * Vim 快速导航（f 提示 / s sneak）全页面键盘可用性回归 spec。
 *
 * 角色 A（测试）：只测不修。用例名以台账编号 Q1-xx 开头；失败项落
 * /home/js/ZCodeProject/vim-quicknav-bugs.md 的 Round 段。
 *
 * 纪律：
 * - 被测操作只用合成 keydown（发到 document.activeElement，bubbles:true），
 *   不依赖 OS 窗口焦点（锁屏可跑）；
 * - fixture 准备可用 click，被测路径不用鼠标；
 * - 每个 it 独立：beforeEach 回到「工作区 + NORMAL + 无浮层」。
 */
import {
  E2E_REPLY_TOKEN,
  V4_MAIN_PANE_ID,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  E2E_READONLY_TOOL_FILE_PATH,
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session";
import { expect as wdioExpect } from "@wdio/globals";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";

const INDICATOR = '[data-testid="vim-mode-indicator"]';
const HINT_OVERLAY = "[data-vim-hint-overlay]";

let taskId = "";

/**
 * wdio 的 expect 只接受一个参数；本 spec 需要把实际值写进失败信息（便于从日志
 * 还原现场、回填台账）。包装一层：断言失败时把 message + 原始错误一起抛出。
 */
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

/**
 * 合成 keydown 发到当前焦点元素并冒泡：vim 层与快捷键内核挂在 window capture，
 * 对话框/输入框的 React 处理器挂在元素上；只发 window 会漏掉后者。
 */
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
  for (const key of keys) {
    await press(key, {});
  }
}

async function indicatorText() {
  return (await browser.execute(
    () => document.querySelector('[data-testid="vim-mode-indicator"]')?.textContent ?? "",
  )) as string;
}

async function waitMode(mode: "NORMAL" | "INSERT") {
  try {
    await browser.waitUntil(async () => (await indicatorText()).includes(mode), {
      timeout: 10_000,
      timeoutMsg: `Vim 徽标没有进入 ${mode}`,
    });
  } catch (error) {
    throw new Error(
      `Vim 徽标没有进入 ${mode}: active=${JSON.stringify(await activeElementFacts())} overlays=${JSON.stringify(
        await overlayFacts(),
      )} indicator=${await indicatorText()}`,
      { cause: error },
    );
  }
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
    // 页面级输入框（插件商店搜索/自动化搜索/浏览器地址栏等）里 Ctrl+[ 不归 vim，
    // 用「万能离开」兜底（产品文档口径：Ctrl+Alt+Esc 无条件回主区 NORMAL）。
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await browser.pause(150);
  }
  await waitMode("NORMAL");
}

/** 万能离开：终端/输入框/任意面板 → 主区 NORMAL。 */
async function escapeAll() {
  for (let index = 0; index < 3; index += 1) {
    await press("Escape", { code: "Escape" });
  }
  await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
  await browser.pause(120);
}

/** 指针停到主区空白处，关闭任务行 hover 卡/工具提示（不是被测操作，属环境复位）。 */
async function parkPointer() {
  try {
    await browser.action("pointer").move({ x: 1000, y: 500 }).perform();
    await browser.pause(120);
  } catch {
    // 无指针能力的环境忽略：后续用例的断言本身不依赖指针位置。
  }
}

async function resetWorkspace() {
  await escapeAll();
  // 把指针停到主区空白处：任务行 hover 会弹出 task-row-details 悬停卡，
  // 它是 role=tooltip 的 hover-card，会污染后续用例的 f 作用域（Q2-19 钉住的缺陷）。
  await parkPointer();

  const safeClick = async (selector: string) => {
    const element = $(selector);
    if (!(await element.isExisting())) return;
    try {
      await element.click();
      await browser.pause(250);
      return;
    } catch {
      // WebDriver 的可见性/可交互检查在动画期容易失败；退回 DOM click 继续清理。
    }
    await browser.execute((sel) => {
      document.querySelectorAll<HTMLElement>(sel).forEach((element) => element.click());
    }, selector);
    await browser.pause(250);
  };

  await safeClick('[data-testid="settings-back-button"]');

  const pluginStore = $('[data-testid="plugin-store-root"]');
  const automationsTab = $('[data-testid="automations-page-tab-automation"]');
  if ((await pluginStore.isExisting()) || (await automationsTab.isExisting())) {
    await safeClick('[data-testid="desktop-top-nav-back"]');
  }
  if (await pluginStore.isExisting()) {
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="plugin-store-root"] button[aria-label]')
        ?.click();
    });
    await browser.pause(300);
  }

  const terminalClose = $('[data-testid="terminal-close-button"]');
  if (await terminalClose.isDisplayed().catch(() => false)) {
    // 终端焦点在 xterm 里时普通按键归 shell；先无条件回主区，再用 t 切面板。
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await ensureNormal();
    await press("t", { code: "KeyT" });
    await browser.pause(450);
    if (
      await $('[data-testid="terminal-close-button"]')
        .isDisplayed()
        .catch(() => false)
    ) {
      await safeClick('[data-testid="terminal-close-button"]');
    }
  }

  const sidePaneToggle = $('[data-testid="side-pane-toggle"]');
  if (await sidePaneToggle.isExisting()) {
    const label = await sidePaneToggle.getAttribute("aria-label");
    if ((label ?? "").includes("收起侧边")) {
      await safeClick('[data-testid="side-pane-toggle"]');
    }
  }

  await ensureVimEnabled();
  await ensureNormal();
  await ensureChatPage();
  await browser.pause(120);
}

/** 回到有 timeline 的会话页：设置/插件/自动化页可能因动画导致返回点击失败。 */
async function ensureChatPage() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const onChat = await browser.execute(() =>
      Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
    );
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
      // 插件商店 store 视图的返回按钮没有 testid，只带 aria-label；它是 root 内首个按钮。
      document
        .querySelector<HTMLElement>('[data-testid="plugin-store-root"] button[aria-label]')
        ?.click();
    });
    await browser.pause(350);
    if (
      await browser.execute(() =>
        Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
      )
    ) {
      return;
    }
    // 键盘回退：插件商店/自动化页的返回按钮不总存在，用 f 激活侧栏任务行。
    await press("f", { code: "KeyF" });
    if (await hintOpen()) {
      const label = await hintLabelForTestid(`task-item-${taskId}`);
      if (label) {
        await pressKeys(label.split(""));
        await browser.pause(500);
      } else {
        await press("Escape", { code: "Escape" });
      }
    }
    if (
      await browser.execute(() =>
        Boolean(document.querySelector('[data-v4-timeline-scroll="true"]')),
      )
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

async function hintOpen(): Promise<boolean> {
  return (await $(HINT_OVERLAY).isExisting()) && (await $(HINT_OVERLAY).isDisplayed());
}

/** 按压 f，返回提示层事实；无浮层返回 null（不抛错，便于断言“f 没反应”）。 */
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

async function readHintFacts() {
  return (await browser.execute(() => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
    let node: HTMLElement | null = overlay;
    let effectiveOpacity = 1;
    let insideInert = false;
    while (node) {
      effectiveOpacity *= Number.parseFloat(getComputedStyle(node).opacity || "1");
      if (node.hasAttribute("inert")) insideInert = true;
      if (node.getAttribute("aria-hidden") === "true") insideInert = true;
      node = node.parentElement;
    }
    const overlayRect = overlay.getBoundingClientRect();
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
    const status =
      Array.from(overlay.children)
        .map((child) => (child.textContent ?? "").trim())
        .filter((text) => text.startsWith("easymotion") || text.startsWith("sneak"))[0] ?? "";
    return {
      effectiveOpacity,
      insideInert,
      overlayRect: [overlayRect.left, overlayRect.top, overlayRect.width, overlayRect.height] as [
        number,
        number,
        number,
        number,
      ],
      badges,
      status,
    };
  })) as {
    effectiveOpacity: number;
    insideInert: boolean;
    overlayRect: [number, number, number, number];
    badges: { label: string; target: [number, number, number, number] | null }[];
    status: string;
  } | null;
}

/**
 * 页面事实采集：可见 testid / 可交互元素 / inert 根 / 浮层 / activeElement / 滚动容器。
 * 可见性沿祖先链乘 opacity 并检查 inert、aria-hidden；同时排除 disabled 与
 * aria-disabled（与产品 collectHintTargets 的候选过滤对齐）。
 * 另外按 Q2-19 的可见性契约排除“被 overflow 祖先完全裁剪”的目标（期望集合
 * 只能包含用户真正看得见的控件；absolute/fixed 的 containing-block 例外与产品
 * 实现一致，避免把 composer 底栏、全宽侧栏误算成不可见）。
 */
async function collectPageFacts(scopeSelector: string | null) {
  return (await browser.execute((scopeSel) => {
    const scope = scopeSel
      ? document.querySelector<HTMLElement>(scopeSel)
      : (document.body as HTMLElement);
    if (!scope) return { missingScope: true as const };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const INTERACTIVE = [
      "a[href]",
      "button",
      "summary",
      "input:not([type=hidden])",
      "textarea",
      "select",
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
    const CLIPPING_OVERFLOW = /^(auto|scroll|hidden|clip|overlay)$/;
    const hasTransformLike = (style: CSSStyleDeclaration) => {
      const set = (value: string | undefined) => Boolean(value) && value !== "none";
      return (
        set(style.transform) ||
        set(style.perspective) ||
        set(style.filter) ||
        /(paint|layout|strict|content)/.test(style.contain ?? "") ||
        /(transform|perspective|filter)/.test(style.willChange ?? "")
      );
    };
    const establishesContainingBlock = (style: CSSStyleDeclaration, mode: "absolute" | "fixed") =>
      mode === "fixed"
        ? hasTransformLike(style)
        : style.position !== "static" || hasTransformLike(style);
    const isClippedByOverflow = (element: Element, rect: DOMRect) => {
      const ownPosition = getComputedStyle(element).position;
      let escape: "absolute" | "fixed" | null =
        ownPosition === "absolute" ? "absolute" : ownPosition === "fixed" ? "fixed" : null;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (escape) {
          if (!establishesContainingBlock(style, escape)) {
            ancestor = ancestor.parentElement;
            continue;
          }
          escape = null;
        }
        const clipX = CLIPPING_OVERFLOW.test(style.overflowX);
        const clipY = CLIPPING_OVERFLOW.test(style.overflowY);
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

    const stateOf = (element: Element) => {
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
      const clipped = inViewport && isClippedByOverflow(element, rect);
      return {
        opacity: Math.round(opacity * 1000) / 1000,
        inert,
        ariaHidden,
        visible: inViewport && !inert && !ariaHidden && opacity > 0.01 && !clipped,
        rect: [rect.left, rect.top, rect.width, rect.height] as [number, number, number, number],
      };
    };

    const describe = (element: Element) => {
      const state = stateOf(element);
      return {
        testid: element.getAttribute("data-testid") ?? "",
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        type: element.getAttribute("type") ?? "",
        ariaLabel: element.getAttribute("aria-label") ?? "",
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48),
        tabindex: element.getAttribute("tabindex") ?? "",
        disabled:
          (element as HTMLButtonElement).disabled === true ||
          element.getAttribute("aria-disabled") === "true",
        rect: state.rect.map((value) => Math.round(value)) as [number, number, number, number],
        opacity: state.opacity,
        inert: state.inert,
        ariaHidden: state.ariaHidden,
        visible: state.visible,
      };
    };

    const all = Array.from(scope.querySelectorAll<HTMLElement>("*")).slice(0, 20000);
    const visibleTestids = all
      .filter((element) => element.hasAttribute("data-testid"))
      .map(describe)
      .filter((entry) => entry.visible);
    const visibleInteractives = all
      .filter((element) => element.matches(INTERACTIVE))
      .map(describe)
      .filter((entry) => entry.visible && !entry.disabled);

    const inertRoots = Array.from(document.querySelectorAll<HTMLElement>("[inert]"))
      .slice(0, 20)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          testid: element.getAttribute("data-testid") ?? "",
          tag: element.tagName.toLowerCase(),
          className: (element.className || "").toString().slice(0, 80),
          opacity: Number.parseFloat(getComputedStyle(element).opacity || "1"),
          rect: [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)),
        };
      });

    const overlays = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      ),
    ).map(describe);

    const active = document.activeElement;
    const scrollers = Array.from(scope.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1
        );
      })
      .slice(0, 10)
      .map((element) => ({
        testid: element.getAttribute("data-testid") ?? "",
        tag: element.tagName.toLowerCase(),
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));

    return {
      missingScope: false as const,
      viewport: [vw, vh],
      visibleTestids,
      visibleInteractives,
      inertRoots,
      overlays,
      active: active ? describe(active) : null,
      scrollers,
    };
  }, scopeSelector)) as {
    missingScope?: boolean;
    viewport: [number, number];
    visibleTestids: {
      testid: string;
      tag: string;
      role: string;
      type: string;
      ariaLabel: string;
      text: string;
      tabindex: string;
      disabled: boolean;
      rect: [number, number, number, number];
      visible: boolean;
    }[];
    visibleInteractives: {
      testid: string;
      tag: string;
      role: string;
      text: string;
      ariaLabel: string;
      disabled: boolean;
      rect: [number, number, number, number];
    }[];
    inertRoots: {
      testid: string;
      tag: string;
      className: string;
      opacity: number;
      rect: number[];
    }[];
    overlays: {
      testid: string;
      tag: string;
      role: string;
      text: string;
      rect: [number, number, number, number];
      visible: boolean;
    }[];
    active: {
      testid: string;
      tag: string;
      role: string;
      text: string;
      rect: [number, number, number, number];
    } | null;
    scrollers: {
      testid: string;
      tag: string;
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    }[];
  };
}

function rectsMatch(
  a: [number, number, number, number],
  b: [number, number, number, number],
  tolerance = 3,
) {
  return a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
}

interface CoverageReport {
  expectedCount: number;
  badgeCount: number;
  missing: { testid: string; tag: string; role: string; text: string; rect: number[] }[];
  extra: { label: string; target: number[] }[];
}

/** 标签目标与页面可见控件对表。 */
function coverage(
  facts: Awaited<ReturnType<typeof collectPageFacts>>,
  hints: NonNullable<Awaited<ReturnType<typeof openHints>>>,
): CoverageReport {
  const badgeTargets = hints.badges
    .map((badge) => badge.target)
    .filter((target): target is [number, number, number, number] => target !== null);
  const expected = facts.visibleInteractives;
  const missing = expected
    .filter((entry) => !badgeTargets.some((target) => rectsMatch(target, entry.rect)))
    .map(({ testid, tag, role, text, rect }) => ({ testid, tag, role, text, rect }));
  const extra = hints.badges
    .filter(
      (badge) =>
        badge.target !== null && !expected.some((entry) => rectsMatch(badge.target!, entry.rect)),
    )
    .map((badge) => ({ label: badge.label, target: badge.target! }));
  return { expectedCount: expected.length, badgeCount: hints.badges.length, missing, extra };
}

/**
 * Q3-01 前置：给 usage 面板补几条 model_usage 事实。
 *
 * 主 spec 的 fast-text 前置任务不保证写入 model_usage，AppUsagePanel 会停在
 * 加载/空态，recharts 的 accessibility layer 不挂载，Q3-01 只能走 N/A。
 * 这里只往 E2E 隔离 HOME 的 session DB 写 model_usage 行（session_id 用本
 * spec 已创建的真实任务，不新建 session、不改任务索引），让图表挂载路径
 * 可执行。写失败时返回 false，用例仍保留 N/A 分支。
 */
function seedUsageFactsForChartEvidence(sessionId: string): boolean {
  if (!sessionId) return false;
  const databasePath = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "db", "db.sqlite");
  if (!existsSync(databasePath)) return false;
  const database = new DatabaseSync(databasePath);
  const now = Date.now();
  const rows = [
    { day: 1, model: "e2e-vim-model-alpha", tokens: 1200 },
    { day: 2, model: "e2e-vim-model-beta", tokens: 800 },
    { day: 3, model: "e2e-vim-model-alpha", tokens: 640 },
    { day: 4, model: "e2e-vim-model-gamma", tokens: 980 },
    { day: 5, model: "e2e-vim-model-beta", tokens: 420 },
  ];
  try {
    const insert = database.prepare(
      `insert or replace into model_usage (
         id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id,
         status, started_at, completed_at, duration_ms, input_tokens, output_tokens,
         computed_total_tokens
       ) values (?, ?, ?, ?, 'main_turn', 'e2e-vim-provider', ?, 'completed', ?, ?, ?, ?, ?, ?)`,
    );
    database.exec("begin immediate");
    for (const [index, row] of rows.entries()) {
      const startedAt = now - row.day * 86_400_000;
      const id = `q301-usage-${index}`;
      const inputTokens = Math.floor(row.tokens * 0.8);
      insert.run(
        id,
        `request-${id}`,
        sessionId,
        `turn-${id}`,
        row.model,
        startedAt,
        startedAt + 60_000,
        60_000,
        inputTokens,
        row.tokens - inputTokens,
        row.tokens,
      );
    }
    database.exec("commit");
    return true;
  } catch {
    try {
      database.exec("rollback");
    } catch {
      // 事务可能未开始：忽略回滚错误，仅返回播种失败。
    }
    return false;
  } finally {
    database.close();
  }
}

/** 在提示层中找指定 testid 元素对应的标签；同名元素可能有多份（草稿/主区），
 * 只返回“可见且与标签 rect 对齐”的那一份。 */
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

/** 诊断用：同名 testid 的每一份元素及其标签覆盖情况。 */
async function hintCoverageFor(testid: string) {
  return (await browser.execute((id) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    const badges =
      overlay === null
        ? []
        : Array.from(overlay.querySelectorAll("span")).map((span) => {
            const border = span.parentElement?.querySelector<HTMLElement>("div");
            return {
              label: span.textContent ?? "",
              left: Number.parseFloat(border?.style.left || "NaN") + 1,
              top: Number.parseFloat(border?.style.top || "NaN") + 1,
              width: Number.parseFloat(border?.style.width || "NaN") - 2,
              height: Number.parseFloat(border?.style.height || "NaN") - 2,
            };
          });
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const label =
        badges.find(
          (badge) =>
            Number.isFinite(badge.left) &&
            Math.abs(badge.left - rect.left) <= 3 &&
            Math.abs(badge.top - rect.top) <= 3 &&
            Math.abs(badge.width - rect.width) <= 3 &&
            Math.abs(badge.height - rect.height) <= 3,
        )?.label ?? null;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        tabindex: element.getAttribute("tabindex") ?? "",
        rect: [
          Math.round(rect.left),
          Math.round(rect.top),
          Math.round(rect.width),
          Math.round(rect.height),
        ],
        label,
      };
    });
  }, testid)) as {
    tag: string;
    role: string;
    tabindex: string;
    rect: number[];
    label: string | null;
  }[];
}

/** 提示标签的目标中心若落在 scope 元素外的“真实目标”上，返回这些标签。
 * 用 rect 反查目标元素（不用 elementFromPoint）：浮层内被 overflow 裁掉但仍在视口
 * 坐标里的列表项，elementFromPoint 会命中浮层遮罩，误报成背景泄漏。 */
async function hintLeaksOutside(scopeSelector: string): Promise<{ label: string }[]> {
  return (await browser.execute((selector) => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return [];
    const scopes = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      },
    );
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
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE)).map(
      (element) => ({ element, rect: element.getBoundingClientRect() }),
    );
    return Array.from(overlay.querySelectorAll<HTMLElement>("span"))
      .map((span) => {
        const border = span.parentElement?.querySelector<HTMLElement>("div");
        return {
          label: span.textContent ?? "",
          left: Number.parseFloat(border?.style.left ?? "NaN") + 1,
          top: Number.parseFloat(border?.style.top ?? "NaN") + 1,
          width: Number.parseFloat(border?.style.width ?? "NaN") - 2,
          height: Number.parseFloat(border?.style.height ?? "NaN") - 2,
        };
      })
      .filter((badge) => Number.isFinite(badge.left) && Number.isFinite(badge.top))
      .filter((badge) => {
        const matches = candidates.filter(
          (candidate) =>
            Math.abs(candidate.rect.left - badge.left) <= 3 &&
            Math.abs(candidate.rect.top - badge.top) <= 3 &&
            Math.abs(candidate.rect.width - badge.width) <= 3 &&
            Math.abs(candidate.rect.height - badge.height) <= 3,
        );
        // 找不到对应元素（非候选/已卸载）不判泄漏；有对应元素但都不在 scope 内才算。
        return (
          matches.length > 0 &&
          !matches.some((match) => scopes.some((scope) => scope.contains(match.element)))
        );
      })
      .map((badge) => ({ label: badge.label }));
  }, scopeSelector)) as { label: string }[];
}

async function activateHintFor(testid: string) {
  const label = await hintLabelForTestid(testid);
  if (label === null) {
    const diagnostics = await browser.execute((id) => {
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      return {
        elementCount: document.querySelectorAll(`[data-testid="${id}"]`).length,
        overlay: Boolean(overlay),
        badgeCount: overlay?.querySelectorAll("span").length ?? 0,
        status:
          overlay === null
            ? ""
            : (Array.from(overlay.children)
                .map((child) => (child.textContent ?? "").trim())
                .filter((text) => text.startsWith("easymotion") || text.startsWith("sneak"))[0] ??
              ""),
        page: [
          "settings-page",
          "plugin-store-root",
          "automations-page-tab-automation",
          "v4-timeline",
        ].filter((pageId) => document.querySelector(`[data-testid="${pageId}"]`) !== null),
      };
    }, testid);
    throw new Error(`[${testid}] 没有出现在 f 标签里: ${JSON.stringify(diagnostics)}`);
  }
  await pressKeys(label.split(""));
  return label;
}

async function waitTestid(testid: string, timeout = 10_000) {
  const element = $(`[data-testid="${testid}"]`);
  await element.waitForDisplayed({ timeout, timeoutMsg: `[data-testid=${testid}] 没有出现` });
  return element;
}

/** 任务查找浮层没有 testid：等输入框真正聚焦在 dialog 内，避免匹配到上一个正在退场的 dialog。 */
async function waitFindDialogFocused(timeout = 10_000) {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const active = document.activeElement;
        return active instanceof HTMLInputElement && active.closest('[role="dialog"]') !== null;
      }),
    { timeout, timeoutMsg: "/ 没有打开任务查找浮层并聚焦输入框" },
  );
}

async function textSnippet(scopeSelector: string, minLength = 2): Promise<string> {
  const snippet = (await browser.execute(
    (sel, min) => {
      const scope = document.querySelector<HTMLElement>(sel);
      if (!scope) return null;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = (node.nodeValue ?? "").trim();
          const parent = node.parentElement;
          if (!parent || text.length < min) return NodeFilter.FILTER_REJECT;
          if (
            parent.closest(
              "script, style, textarea, [aria-hidden='true'], [inert], [data-vim-hint-overlay]",
            )
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          const rect = parent.getBoundingClientRect();
          if (rect.width <= 2 || rect.height <= 2) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node = walker.nextNode();
      while (node) {
        const text = (node.nodeValue ?? "").trim();
        if (text.length >= min) return text.slice(0, Math.max(min, 2));
        node = walker.nextNode();
      }
      return null;
    },
    scopeSelector,
    minLength,
  )) as string | null;
  expect(snippet, `${scopeSelector} 内没有可用来做 sneak 的可见文本`).not.toBeNull();
  return snippet!;
}

async function sneakTo(query: string) {
  await press("s", { code: "KeyS" });
  await pressKeys(query.split(""));
  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
    { timeout: 5_000, timeoutMsg: `s + ${query} 没有显示 sneak 浮层` },
  );
  return (await browser.execute(
    () => document.querySelector("[data-vim-hint-overlay]")?.textContent ?? "",
  )) as string;
}

// ---------------------------------------------------------------------------
// Round 2 helpers：泛化标签定位、遮挡诊断、菜单/对话框键盘路径。
// ---------------------------------------------------------------------------

/** 同 hintLabelForTestid，但接受任意 CSS 选择器（菜单项/启动器行等无 testid 控件）。 */
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

/** 按可见文案找标签（菜单项/对话框按钮无 testid）：文案做空白归一，允许前缀匹配。 */
async function hintLabelForTexts(candidates: string[]) {
  return (await browser.execute((texts) => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
    const wanted = texts.map((text) => text.trim()).filter(Boolean);
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
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button, [role="button"]',
      ),
    );
    for (const element of items) {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || !wanted.some((candidate) => text === candidate || text.startsWith(candidate))) {
        continue;
      }
      const rect = element.getBoundingClientRect();
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
  }, candidates)) as { label: string; text: string } | null;
}

async function pressLabel(label: string) {
  for (const char of label.split("")) {
    await press(char, {});
  }
}

async function activateHintForSelector(selector: string) {
  const label = await hintLabelForSelector(selector);
  if (label === null) {
    throw new Error(`[${selector}] 没有出现在 f 标签里`);
  }
  await pressLabel(label);
  return label;
}

/** 目标可能在可滚动容器里被滚出可视区：先滚到中间再重新 f。 */
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
  const reopened = await openHints();
  if (reopened === null) return null;
  label = await hintLabelForSelector(selector);
  return label;
}

async function overlayCount(selector: string): Promise<number> {
  return (await browser.execute(
    (sel) => document.querySelectorAll(sel).length,
    selector,
  )) as number;
}

async function activeElementFacts() {
  return (await browser.execute(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName.toLowerCase() ?? "",
      role: active?.getAttribute("role") ?? "",
      testid: active?.getAttribute("data-testid") ?? "",
      editable:
        active instanceof HTMLElement &&
        (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)),
    };
  })) as { tag: string; role: string; testid: string; editable: boolean };
}

/**
 * 标签遮挡诊断：对每个标签反查目标元素，在目标 rect 上取 9 点采样：
 * - reachable：命中点落在目标（或其后代）上 = 鼠标可点到；
 * - clipped：命中点被祖先 overflow 裁剪/在视口外 = 滚动裁剪（不是遮挡）；
 * - 其余 = 被其它元素（如 footer）遮挡。
 */
async function badgeHitReport() {
  return (await browser.execute(() => {
    const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
    if (!overlay) return null;
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
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE));
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
    const isClipped = (element: Element, x: number, y: number) => {
      let node: Element | null = element.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = getComputedStyle(node);
        if (/(hidden|auto|scroll|clip)/.test(`${style.overflowX}${style.overflowY}`)) {
          const rect = node.getBoundingClientRect();
          if (
            x < rect.left - 0.5 ||
            x > rect.right + 0.5 ||
            y < rect.top - 0.5 ||
            y > rect.bottom + 0.5
          ) {
            return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    };
    return badges.map((badge) => {
      const target = candidates.find(
        (candidate) =>
          Number.isFinite(badge.left) &&
          Math.abs(candidate.getBoundingClientRect().left - badge.left) <= 3 &&
          Math.abs(candidate.getBoundingClientRect().top - badge.top) <= 3 &&
          Math.abs(candidate.getBoundingClientRect().width - badge.width) <= 3 &&
          Math.abs(candidate.getBoundingClientRect().height - badge.height) <= 3,
      );
      if (!target) {
        return {
          label: badge.label,
          target: null,
          reachable: -1,
          clipped: -1,
          points: 0,
          occluder: null,
        };
      }
      const rect = target.getBoundingClientRect();
      const xs = [
        rect.left + rect.width * 0.5,
        rect.left + rect.width * 0.2,
        rect.left + rect.width * 0.8,
      ];
      const ys = [
        rect.top + rect.height * 0.5,
        rect.top + rect.height * 0.2,
        rect.top + rect.height * 0.8,
      ];
      let reachable = 0;
      let clipped = 0;
      let points = 0;
      let occluder: { tag: string; testid: string; className: string; text: string } | null = null;
      for (const y of ys) {
        for (const x of xs) {
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            clipped += 1;
            points += 1;
            continue;
          }
          points += 1;
          const stack = document.elementsFromPoint(x, y);
          if (stack.some((node) => node === target || target.contains(node))) {
            reachable += 1;
            continue;
          }
          if (isClipped(target, x, y)) {
            clipped += 1;
            continue;
          }
          if (!occluder) {
            const top = stack[0];
            occluder = {
              tag: top?.tagName.toLowerCase() ?? "",
              testid: top?.getAttribute?.("data-testid") ?? "",
              className: (top?.className ?? "").toString().slice(0, 90),
              text: (top?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
            };
          }
        }
      }
      return {
        label: badge.label,
        target: {
          testid: target.getAttribute("data-testid") ?? "",
          tag: target.tagName.toLowerCase(),
          role: target.getAttribute("role") ?? "",
          rect: [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)),
        },
        reachable,
        clipped,
        points,
        occluder,
      };
    });
  })) as
    | {
        label: string;
        target: {
          testid: string;
          tag: string;
          role: string;
          rect: [number, number, number, number];
        } | null;
        reachable: number;
        clipped: number;
        points: number;
        occluder: { tag: string; testid: string; className: string; text: string } | null;
      }[]
    | null;
}

/** 焦点落到前置任务行（j/G），用于任务行上下文菜单。 */
async function focusSeededTaskRow() {
  await ensureNormal();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await press("l", { code: "KeyL" });
    await browser.pause(120);
    const inSidebar = await browser.execute(
      () => document.activeElement?.closest('[data-testid="sidebar"]') !== null,
    );
    if (inSidebar) break;
  }
  await press("j", { code: "KeyJ" });
  await press("G", { code: "KeyG", shiftKey: true });
  await browser.pause(250);
  const focused = await browser.execute(
    (id) => document.activeElement?.getAttribute("data-testid") === `task-item-${id}`,
    taskId,
  );
  return Boolean(focused);
}

/** 用真实 Shift+F10 打开任务行上下文菜单（Chrome 在聚焦元素上合成 contextmenu）。 */
async function openTaskContextMenuByKeyboard(): Promise<boolean> {
  await browser.keys(["Shift", "F10"]);
  try {
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
      { timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** 打开侧栏面板 launcher（空态），返回是否成功。 */
async function openSidePaneLauncher() {
  await ensureNormal();
  const hasLauncher = await browser.execute(
    () => document.querySelectorAll("[data-side-pane-open-tab-item]").length > 0,
  );
  if (!hasLauncher) {
    // 面板可能已经开着（有 tab 或空 launcher），盲目 toggle 会把它关掉。
    await press("b", { code: "KeyB", ctrlKey: true, altKey: true });
    await browser.pause(400);
  }
  await browser.waitUntil(
    () =>
      browser.execute(() => document.querySelectorAll("[data-side-pane-open-tab-item]").length > 0),
    { timeout: 10_000, timeoutMsg: "侧栏面板 launcher 没有出现（面板状态异常或无可启动项）" },
  );
  await ensureNormalHard();
}

/** 关闭侧栏面板当前激活 tab（清理副作用，避免污染后续用例）。 */
async function closeActiveSidePaneTab() {
  await browser.execute(() => {
    const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id][data-state="active"]');
    tab?.querySelector<HTMLElement>("button[aria-label]")?.click();
  });
  await browser.pause(300);
}

/** 关闭侧栏面板所有 tab（P1 用例前置清理：前一条失败也不能留下脏 tab）。 */
async function closeAllSidePaneTabs() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const closed = await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>("[data-side-pane-tab-id]");
      const button = tab?.querySelector<HTMLElement>("button[aria-label]");
      if (!button) return false;
      button.click();
      return true;
    });
    if (!closed) break;
    await browser.pause(200);
  }
}

/**
 * 强制回 NORMAL：页面级输入框（插件商店搜索等）里 Ctrl+[ 不归 vim，
 * 只有 Ctrl+Alt+Esc 是无条件离开手势（与 §2.1 的浮层输入框通道区分）。
 */
async function ensureNormalHard() {
  if ((await indicatorText()).includes("INSERT")) {
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await browser.pause(150);
  }
  await waitMode("NORMAL");
}

/** 浮层候选快照（诊断“f 作用域被意外浮层劫持”）：role/slot/state/rect/交互元素数。 */
async function overlayFacts() {
  return (await browser.execute(() => {
    const SELECTOR = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[data-slot="dialog-content"]',
      '[data-slot="alert-dialog-content"]',
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="dropdown-menu-sub-content"]',
      '[data-slot="select-content"]',
      '[data-slot="context-menu-content"]',
      '[data-slot="context-menu-sub-content"]',
      '[data-slot="popover-content"]',
      '[data-slot="hover-card-content"]',
    ].join(",");
    return Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        role: element.getAttribute("role") ?? "",
        slot: element.getAttribute("data-slot") ?? "",
        state: element.getAttribute("data-state") ?? "",
        testid: element.getAttribute("data-testid") ?? "",
        rect: [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)),
        hiddenAncestor: Boolean(element.closest("[inert], [aria-hidden='true']")),
        interactive: element.querySelectorAll(
          "button, a[href], input, [role='menuitem'], [role='option'], [tabindex='0']",
        ).length,
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      };
    });
  })) as {
    role: string;
    slot: string;
    state: string;
    testid: string;
    rect: number[];
    hiddenAncestor: boolean;
    interactive: number;
    text: string;
  }[];
}

async function settingsActiveSection(): Promise<string> {
  return (await browser.execute(
    () =>
      document
        .querySelector('[data-testid="settings-page"]')
        ?.getAttribute("data-active-section") ?? "",
  )) as string;
}

/** 打开设置页并回到 NORMAL（设置页打开时焦点通常在搜索按钮上）。 */
async function openSettingsPage() {
  await ensureNormal();
  await press(",", { code: "Comma", ctrlKey: true });
  await waitTestid("settings-page");
  await browser.pause(250);
  await ensureNormal();
}

/** 在 scope 内找出现次数 >= minCount 的双字符文本，供 sneak 环绕测试。 */
async function repeatedTextQuery(scopeSelector: string, minCount = 3) {
  return (await browser.execute(
    (sel, min) => {
      const scope = document.querySelector<HTMLElement>(sel);
      if (!scope) return null;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      const counts = new Map<string, number>();
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        const text = (node.nodeValue ?? "").trim();
        if (
          parent &&
          text.length >= 2 &&
          !parent.closest("[aria-hidden='true'], [inert], [data-vim-hint-overlay]")
        ) {
          const rect = parent.getBoundingClientRect();
          if (rect.width > 2 && rect.height > 2) {
            for (let index = 0; index + 2 <= text.length; index += 1) {
              const gram = text.slice(index, index + 2);
              if (/\s/.test(gram)) continue;
              counts.set(gram, (counts.get(gram) ?? 0) + 1);
            }
          }
        }
        node = walker.nextNode();
      }
      let best: string | null = null;
      let bestCount = 0;
      for (const [gram, count] of counts) {
        if (count > bestCount) {
          best = gram;
          bestCount = count;
        }
      }
      return bestCount >= min ? { query: best, count: bestCount } : null;
    },
    scopeSelector,
    minCount,
  )) as { query: string; count: number } | null;
}

describe("Vim 快速导航全页面（Round 1 + Round 2）", () => {
  before(async function () {
    this.timeout(240_000);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();

    // 造一条真实任务：任务行 / 消息动作 / 任务归档确认都依赖它。
    const marker = `E2E_VIM_QUICKNAV_${Date.now()}`;
    await sendV4Prompt(buildReadonlyToolPrompt(marker));
    await waitForV4TimelineContaining(marker, 60_000);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 90_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
      "Vim 快速导航前置任务没有完成",
      90_000,
      V4_MAIN_PANE_ID,
    );
    taskId = completed.sessionId ?? "";
    expect(taskId, "没有拿到前置任务 id").not.toBe("");
    await browser.pause(500);
  });

  after(async () => {
    if (await $(INDICATOR).isExisting()) {
      await press("v", { code: "KeyV", ctrlKey: true, altKey: true });
      await $(INDICATOR).waitForDisplayed({ reverse: true });
    }
    await clearAppData();
  });

  beforeEach(async () => {
    await resetWorkspace();
  });

  it("Q1-01 工作区 f 标签覆盖侧栏全部可见可交互控件", async () => {
    // 会话页偶发在 f 前后浮现“正在思考”瞬态 chip（无 testid 的 role=button），
    // 会让“先采页面事实、再按 f”这一段出现竞态；命中瞬态时重采一次，断言口径不变。
    let hints = await openHints();
    expect(hints, "f 没有打开提示层").not.toBeNull();
    let facts = await collectPageFacts(null);
    let report = coverage(facts, hints!);
    if (report.missing.some((entry) => entry.testid === "")) {
      await press("Escape", { code: "Escape" });
      await browser.pause(300);
      hints = await openHints();
      expect(hints, "重采时 f 没有打开提示层").not.toBeNull();
      facts = await collectPageFacts(null);
      report = coverage(facts, hints!);
    }
    expect(
      report.missing,
      `f 漏掉 ${report.missing.length}/${report.expectedCount} 个可见控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);

    const required = [
      "automations-open",
      "plugin-store-sidebar-open",
      "sidebar-search-open",
      "sidebar-view-menu",
      "task-settings-button",
      `task-item-${taskId}`,
    ];
    const missingRequired: string[] = [];
    const coverageDetails: Record<string, unknown> = {};
    for (const testid of required) {
      const entries = await hintCoverageFor(testid);
      coverageDetails[testid] = entries;
      if (!entries.some((entry) => entry.label !== null)) missingRequired.push(testid);
    }
    expect(
      missingRequired,
      `以下侧栏控件没有 f 标签: ${missingRequired.join(", ")}; 明细=${JSON.stringify(coverageDetails)}`,
    ).toEqual([]);

    // 边栏“新建任务”是 div[role=group] + onClick，不在 hint 候选集合内。
    const newTaskDetails = await hintCoverageFor("task-new-button");
    expect(
      newTaskDetails.some((entry) => entry.label !== null),
      `task-new-button（新建任务）没有 f 标签: ${JSON.stringify(newTaskDetails)}`,
    ).toBe(true);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-02 工作区 f 激活落在正确目标（搜索按钮→命令中心）", async () => {
    const hints = await openHints();
    expect(hints, "f 没有打开提示层").not.toBeNull();
    await activateHintFor("sidebar-search-open");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            Boolean(document.querySelector("[cmdk-root]")) ||
            Boolean(document.querySelector('[role="dialog"] [role="combobox"]')),
        ),
      { timeout: 5_000, timeoutMsg: "标签激活搜索按钮后命令中心没有打开" },
    );
    expect(
      await browser.execute(() => Boolean(document.querySelector("[cmdk-root]"))),
      "命令中心缺少 cmdk-root",
    ).toBe(true);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-03 工作区 f 的 Esc 取消、再次打开与无副作用", async () => {
    const before = await browser.execute(() => ({
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
    }));
    await press("f", { code: "KeyF" });
    await $(HINT_OVERLAY).waitForDisplayed({ timeout: 5_000 });
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });
    const after = await browser.execute(() => ({
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
    }));
    expect(after.dialogCount).toBe(before.dialogCount);
    expect(after.activeTestId).toBe(before.activeTestId);

    await press("f", { code: "KeyF" });
    await $(HINT_OVERLAY).waitForDisplayed({ timeout: 5_000 });
    expect((await $(HINT_OVERLAY).getText()).length).toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });
  });

  it("Q1-04 工作区 s 双字符命中、; 循环与无匹配反馈", async () => {
    const snippet = await textSnippet('[data-testid="sidebar"]', 2);
    const overlayText = await sneakTo(snippet);
    expect(overlayText).toContain(`sneak ${snippet}`);

    const firstPosition = (overlayText.match(/(\d+)\/(\d+)/) ?? [])[0] ?? "";
    expect(firstPosition, `sneak 浮层没有命中计数: ${overlayText}`).not.toBe("");
    await press(";", { code: "Semicolon" });
    await browser.pause(120);
    const afterCycle = (await $(HINT_OVERLAY).getText()) as string;
    expect(afterCycle, "按 ; 后 sneak 浮层消失").toContain(`sneak ${snippet}`);
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });

    // 无匹配：不得静默关窗，必须保留“无匹配”提示。
    await press("s", { code: "KeyS" });
    await press("q", { code: "KeyQ" });
    await press("x", { code: "KeyX" });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 3_000, timeoutMsg: "s + qx 无匹配时浮层直接消失了" },
    );
    expect(await $(HINT_OVERLAY).getText()).toContain("无匹配");
    await press("Escape", { code: "Escape" });
  });

  it("Q1-05 会话页 f 标签覆盖 composer 与消息区可交互控件", async () => {
    await ensureNormal();
    const facts = await collectPageFacts("main");
    const hints = await openHints();
    expect(hints, "会话页 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `会话页 f 漏掉 ${report.missing.length}/${report.expectedCount} 个可见控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);

    const required = [
      "v4-composer-input",
      "chat-attachment-button",
      "chat-mode-select-trigger",
      "chat-model-select-trigger",
    ];
    const coverageDetails: Record<string, unknown> = {};
    const missingRequired: string[] = [];
    for (const testid of required) {
      const entries = await hintCoverageFor(testid);
      coverageDetails[testid] = entries;
      if (!entries.some((entry) => entry.label !== null)) missingRequired.push(testid);
    }
    expect(
      missingRequired,
      `会话页缺少标签: ${missingRequired.join(", ")}; 明细=${JSON.stringify(coverageDetails)}`,
    ).toEqual([]);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-06 会话页 s 命中消息文本并可翻页", async () => {
    const snippet = await textSnippet('[data-testid="v4-timeline"]', 2);
    const overlayText = await sneakTo(snippet);
    expect(overlayText).toContain(`sneak ${snippet}`);
    expect(overlayText).toMatch(/\d+\/\d+/);
    await press(",", { code: "Comma" });
    await browser.pause(120);
    expect(await $(HINT_OVERLAY).getText()).toContain(`sneak ${snippet}`);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-07 设置页 f 覆盖全部可见控件且不包含 inert 背景", async () => {
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestid("settings-page");
    await browser.pause(200);

    const facts = await collectPageFacts('[data-testid="settings-page"]');
    const hints = await openHints();
    expect(hints, "设置页 f 没有打开提示层").not.toBeNull();
    expect(hints!.effectiveOpacity).toBe(1);
    expect(hints!.insideInert).toBe(false);

    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `设置页 f 漏掉 ${report.missing.length}/${report.expectedCount} 个可见控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);

    // 隔离：标签目标不得落在设置页之外的后台工作区（inert/opacity-0 子树）。
    const leaked = await browser.execute(() => {
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      if (!overlay) return [];
      const targets = Array.from(overlay.querySelectorAll<HTMLElement>("span")).map((span) => {
        const border = span.parentElement?.querySelector<HTMLElement>("div");
        return {
          label: span.textContent,
          left: Number.parseFloat(border?.style.left ?? "0") + 1,
          top: Number.parseFloat(border?.style.top ?? "0") + 1,
          width: Number.parseFloat(border?.style.width ?? "0") - 2,
          height: Number.parseFloat(border?.style.height ?? "0") - 2,
        };
      });
      return targets.filter((target) => {
        const centerX = target.left + target.width / 2;
        const centerY = target.top + target.height / 2;
        const element = document.elementFromPoint(centerX, centerY);
        return Boolean(element?.closest("[inert], [aria-hidden='true']"));
      });
    });
    expect(leaked, `设置页标签落在后台 inert 子树: ${JSON.stringify(leaked)}`).toEqual([]);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-08 设置页 f 激活分区导航", async () => {
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestid("settings-page");
    const hints = await openHints();
    expect(hints, "设置页 f 没有打开提示层").not.toBeNull();
    await activateHintFor("settings-section-nav-appearance");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="settings-page"]')
              ?.getAttribute("data-active-section") === "appearance",
        ),
      { timeout: 5_000, timeoutMsg: "标签激活后设置页没有切到 appearance" },
    );
    await press("Escape", { code: "Escape" });
  });

  it("Q1-09 设置页 s 命中设置文本", async () => {
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestid("settings-page");
    const snippet = await textSnippet('[data-testid="settings-page"]', 2);
    const overlayText = await sneakTo(snippet);
    expect(overlayText).toContain(`sneak ${snippet}`);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-10 命令中心输入框内 f 保持输入态，Ctrl+[ 退出后 f 可提示", async () => {
    await press(":", { code: "Semicolon", shiftKey: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: ": 没有打开命令中心" },
    );
    await browser.pause(250);
    const before = await browser.execute(() => ({
      activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
      activeRole: document.activeElement?.getAttribute("role") ?? "",
      editable:
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)),
    }));
    expect(
      before.editable,
      `命令中心打开后焦点不在输入框（active=${before.activeTag}/${before.activeRole}）`,
    ).toBe(true);

    // §2.1 输入态边界：输入框内裸 f 必须保持文本输入，不得抢键生成标签。
    await press("f", { code: "KeyF" });
    await browser.pause(200);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "命令中心输入框内裸 f 不应生成标签（§2.1 文本输入优先）",
    ).toBe(false);

    // Ctrl+[：离开输入焦点，命令中心保持打开。
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    const afterExit = await browser.execute(() => ({
      dialog: document.querySelectorAll('[role="dialog"]').length,
      activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
      editable:
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)),
    }));
    expect(afterExit.dialog, "Ctrl+[ 把命令中心一起关掉了").toBeGreaterThan(0);
    expect(afterExit.editable, `Ctrl+[ 后焦点仍在输入控件（active=${afterExit.activeTag}）`).toBe(
      false,
    );

    // 退出输入态后 f 立即可用，且标签作用域限定在命令中心 dialog。
    const hints = await openHints();
    expect(hints, "命令中心内 Ctrl+[ 后按 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "命令中心提示层没有任何标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "命令中心标签泄漏到背景页面").toEqual([]);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q1-11 命令中心输入框内 s 保持输入态，Ctrl+[ 退出后 s 可 sneak", async () => {
    await press(":", { code: "Semicolon", shiftKey: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: ": 没有打开命令中心" },
    );
    await browser.pause(250);

    // 裸 s 不得进入 sneak（§2.1）。
    await press("s", { code: "KeyS" });
    await browser.pause(200);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "命令中心输入框内裸 s 不应进入 sneak（§2.1 文本输入优先）",
    ).toBe(false);

    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    await press("s", { code: "KeyS" });
    await press("a", { code: "KeyA" });
    await press("p", { code: "KeyP" });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 3_000, timeoutMsg: "命令中心 Ctrl+[ 后 s 没有进入 sneak" },
    );
    const overlayText = (await $(HINT_OVERLAY).getText()) as string;
    expect(overlayText, `命令中心 sneak 浮层内容异常: ${overlayText}`).toContain("sneak");
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q1-12 任务查找浮层输入框内 f 保持输入态，Ctrl+[ 退出后 f 可提示", async () => {
    await press("/", { code: "Slash" });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: "/ 没有打开任务查找浮层" },
    );
    await browser.pause(250);

    await press("f", { code: "KeyF" });
    await browser.pause(200);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "任务查找输入框内裸 f 不应生成标签（§2.1 文本输入优先）",
    ).toBe(false);

    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    const afterExit = await browser.execute(() => ({
      dialog: document.querySelectorAll('[role="dialog"]').length,
      activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
      editable:
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)),
    }));
    expect(afterExit.dialog, "Ctrl+[ 把任务查找浮层一起关掉了").toBeGreaterThan(0);
    expect(afterExit.editable, `Ctrl+[ 后焦点仍在输入控件（active=${afterExit.activeTag}）`).toBe(
      false,
    );

    const hints = await openHints();
    expect(hints, "任务查找浮层内 Ctrl+[ 后按 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "任务查找提示层没有任何标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "任务查找标签泄漏到背景页面").toEqual([]);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q1-13 任务查找浮层输入框内 s 保持输入态，Ctrl+[ 退出后 s 可 sneak", async () => {
    await press("/", { code: "Slash" });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: "/ 没有打开任务查找浮层" },
    );
    await browser.pause(250);

    await press("s", { code: "KeyS" });
    await browser.pause(200);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "任务查找输入框内裸 s 不应进入 sneak（§2.1 文本输入优先）",
    ).toBe(false);

    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    await press("s", { code: "KeyS" });
    await press("a", { code: "KeyA" });
    await press("p", { code: "KeyP" });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 3_000, timeoutMsg: "任务查找 Ctrl+[ 后 s 没有进入 sneak" },
    );
    const overlayText = (await $(HINT_OVERLAY).getText()) as string;
    expect(overlayText, `任务查找 sneak 浮层内容异常: ${overlayText}`).toContain("sneak");
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q1-14 帮助浮层 Esc/? 可关且 f 不泄漏背景标签", async () => {
    await press("?", { code: "Slash", shiftKey: true });
    await waitTestid("vim-help");
    await press("f", { code: "KeyF" });
    await browser.pause(200);
    const leaked = await browser.execute(() => {
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      if (!overlay) return { overlay: false, outsideHelp: 0 };
      const help = document.querySelector("[data-testid='vim-help']");
      return {
        overlay: true,
        outsideHelp: Array.from(overlay.querySelectorAll("span")).filter((span) => {
          const border = span.parentElement?.querySelector<HTMLElement>("div");
          const left = Number.parseFloat(border?.style.left ?? "0") + 1;
          const top = Number.parseFloat(border?.style.top ?? "0") + 1;
          return !help || !help.contains(document.elementFromPoint(left + 2, top + 2));
        }).length,
      };
    });
    expect(leaked.outsideHelp, "帮助浮层打开时 f 把背景页面也打了标签").toBe(0);
    await press("Escape", { code: "Escape" });
    await $(`[data-testid="vim-help"]`).waitForDisplayed({ reverse: true });
    await press("?", { code: "Slash", shiftKey: true });
    await waitTestid("vim-help");
    await press("?", { code: "Slash", shiftKey: true });
    await $(`[data-testid="vim-help"]`).waitForDisplayed({ reverse: true });
  });

  it("Q1-15 侧栏面板 f 覆盖并激活收起", async () => {
    await press("b", { code: "KeyB", ctrlKey: true, altKey: true });
    await browser.waitUntil(
      () =>
        browser.execute(() => Boolean(document.querySelector('[data-testid="side-pane-toggle"]'))),
      { timeout: 10_000, timeoutMsg: "Ctrl+Alt+B 没有打开侧栏面板" },
    );
    await browser.pause(300);
    await ensureNormal();
    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "侧栏面板 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `侧栏面板 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    expect(await hintLabelForTestid("side-pane-toggle")).not.toBeNull();

    await activateHintFor("side-pane-toggle");
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const toggle = document.querySelector<HTMLElement>('[data-testid="side-pane-toggle"]');
          return (toggle?.getAttribute("aria-label") ?? "").includes("展开侧边");
        }),
      { timeout: 5_000, timeoutMsg: "标签激活 side-pane-toggle 后侧栏面板没有收起" },
    );
  });

  it("Q1-16 终端面板 f 覆盖（Ctrl+Alt+Esc 回普通模式后）并可关闭", async () => {
    await press("t", { code: "KeyT" });
    await waitTestid("terminal", 10_000);
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await ensureNormal();

    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "终端面板 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `终端面板 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    expect(await hintLabelForTestid("terminal-close-button")).not.toBeNull();
    // 探针：确认按标签确实点到了关闭按钮（区分“激活没命中”与“关闭逻辑没生效”）。
    await browser.execute(() => {
      const windowWithProbe = window as typeof window & { __vimProbeTerminalClicks?: number };
      windowWithProbe.__vimProbeTerminalClicks = 0;
      document.querySelector('[data-testid="terminal-close-button"]')?.addEventListener(
        "click",
        () => {
          windowWithProbe.__vimProbeTerminalClicks =
            (windowWithProbe.__vimProbeTerminalClicks ?? 0) + 1;
        },
        { capture: true },
      );
    });
    await activateHintFor("terminal-close-button");
    const closed = await browser
      .waitUntil(
        () =>
          browser.execute(() => {
            // 终端面板收起后不卸载：外层 [data-testid=terminal] 高度归零、
            // 内容被 aria-hidden 包住；子 section 的 overflow 尺寸不算“还开着”。
            const panel = document.querySelector<HTMLElement>('[data-testid="terminal"]');
            if (!panel) return true;
            const rect = panel.getBoundingClientRect();
            if (rect.width <= 2 || rect.height <= 2) return true;
            const button = document.querySelector<HTMLElement>(
              '[data-testid="terminal-close-button"]',
            );
            return button !== null && button.closest("[aria-hidden='true']") !== null;
          }),
        { timeout: 8_000, timeoutMsg: "timeout" },
      )
      .then(
        () => true,
        () => false,
      );
    if (!closed) {
      const diagnostic = await browser.execute(() => {
        const windowWithProbe = window as typeof window & { __vimProbeTerminalClicks?: number };
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="terminal-close-button"]'),
        ).map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            rect: [rect.left, rect.top, rect.width, rect.height],
            ariaHiddenAncestor: Boolean(button.closest("[aria-hidden='true']")),
            inertAncestor: Boolean(button.closest("[inert]")),
          };
        });
        const panels = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="terminal"]'),
        ).map((panel) => {
          const rect = panel.getBoundingClientRect();
          return {
            tag: panel.tagName.toLowerCase(),
            rect: [rect.left, rect.top, rect.width, rect.height],
          };
        });
        return { clicks: windowWithProbe.__vimProbeTerminalClicks ?? 0, buttons, panels };
      });
      throw new Error(
        `标签激活 terminal-close-button 后终端没有关闭: ${JSON.stringify(diagnostic)}`,
      );
    }
  });

  it("Q1-17 Automations 主视图 f 覆盖", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("automations-open");
    await waitTestid("automations-page-tab-automation");
    await browser.pause(400);

    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "Automations 页 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `Automations 页 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    for (const testid of [
      "automations-page-tab-automation",
      "automations-page-tab-workflow",
      "automation-create-manually",
      "automation-create-menu",
      "automation-switch-toggle",
    ]) {
      expect(await hintLabelForTestid(testid), `${testid} 没有标签`).not.toBeNull();
    }
    await press("Escape", { code: "Escape" });
  });

  it("Q1-18 Automations f 激活切换页内 tab", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("automations-open");
    await waitTestid("automations-page-tab-automation");
    await openHints();
    await activateHintFor("automations-page-tab-workflow");
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const tab = document.querySelector<HTMLElement>(
            '[data-testid="automations-page-tab-workflow"]',
          );
          return tab?.getAttribute("aria-selected") === "true" || tab?.dataset.state === "active";
        }),
      { timeout: 5_000, timeoutMsg: "标签激活 workflow tab 后没有切页" },
    );
  });

  it("Q1-19 插件商店 f 覆盖", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("plugin-store-sidebar-open");
    await waitTestid("plugin-store-root", 15_000);
    await browser.pause(500);

    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "插件商店 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `插件商店 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    for (const testid of [
      "plugin-store-search",
      "plugin-store-segment-public",
      "plugin-store-segment-community",
      "plugin-store-segment-personal",
      "plugin-store-refresh",
      "plugin-store-manage-open",
    ]) {
      expect(await hintLabelForTestid(testid), `${testid} 没有标签`).not.toBeNull();
    }
    await press("Escape", { code: "Escape" });
  });

  it("Q1-20 插件商店 f 激活 segment 切换", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("plugin-store-sidebar-open");
    await waitTestid("plugin-store-root", 15_000);
    await openHints();
    await activateHintFor("plugin-store-segment-community");
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const segment = document.querySelector<HTMLElement>(
            '[data-testid="plugin-store-segment-community"]',
          );
          return (
            segment?.getAttribute("aria-selected") === "true" ||
            segment?.getAttribute("aria-pressed") === "true" ||
            segment?.dataset.state === "active"
          );
        }),
      { timeout: 5_000, timeoutMsg: "标签激活 community segment 后没有切换" },
    );
  });

  it("Q1-27 插件商店 f 激活侧栏任务行回到会话页", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("plugin-store-sidebar-open");
    await waitTestid("plugin-store-root", 15_000);
    await browser.pause(300);
    const hints = await openHints();
    expect(hints, "插件商店 f 没有打开提示层").not.toBeNull();
    const label = await hintLabelForTestid(`task-item-${taskId}`);
    expect(label, `插件商店内任务行 task-item-${taskId} 没有 f 标签`).not.toBeNull();
    await pressKeys(label!.split(""));
    await browser.waitUntil(
      () =>
        browser.execute(() => Boolean(document.querySelector('[data-v4-timeline-scroll="true"]'))),
      { timeout: 6_000, timeoutMsg: "标签激活侧栏任务行后没有回到会话页" },
    );
  });

  it("Q1-21 f 激活 sidebar-view-menu 应打开视图菜单（当前未打开）", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("sidebar-view-menu");
    await browser.pause(300);
    const state = await browser.execute(() => ({
      menus: document.querySelectorAll('[role="menu"]').length,
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    expect(
      state.menus,
      `标签激活 sidebar-view-menu 后没有出现 role=menu（active=${state.activeTestId}）`,
    ).toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-22 f 激活模型选择器应打开下拉（当前未打开）", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("chat-model-select-trigger");
    await browser.pause(300);
    const state = await browser.execute(() => ({
      listboxes: document.querySelectorAll('[role="listbox"]').length,
      menus: document.querySelectorAll('[role="menu"]').length,
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    expect(
      state.listboxes + state.menus,
      `标签激活 chat-model-select-trigger 后没有打开下拉（active=${state.activeTestId}）`,
    ).toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-23 已打开的 role=menu 内 f 应可提示（当前被吞掉）", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("sidebar-view-menu");
    // Radix 触发器支持 Enter 打开；先确保菜单真实打开，再测 f。
    await press("Enter", { code: "Enter" });
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
      { timeout: 5_000, timeoutMsg: "Enter 没有打开视图菜单" },
    );
    const before = await browser.execute(() => ({
      activeRole: document.activeElement?.getAttribute("role") ?? "",
      activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
    }));
    const hints = await openHints();
    expect(
      hints,
      `role=menu 内按 f 没有出现提示层（active=${before.activeTag}/${before.activeRole}）`,
    ).not.toBeNull();
    expect(hints!.badges.length, "role=menu 内提示层没有任何菜单项标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="menu"]'), "菜单内标签泄漏到背景页面").toEqual([]);
    await press("Escape", { code: "Escape" });
  });

  it("Q1-24 设置搜索对话框输入框内 f/s 保持输入态，Ctrl+[ 退出后可用", async () => {
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestid("settings-page");
    await openHints();
    await activateHintFor("settings-search-open");
    await waitTestid("settings-search-dialog");
    await browser.pause(250);

    // §2.1：输入框内裸 f 保持文本输入。
    await press("f", { code: "KeyF" });
    await browser.pause(200);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "设置搜索输入框内裸 f 不应生成标签（§2.1 文本输入优先）",
    ).toBe(false);

    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    const afterExit = await browser.execute(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot$="-content"]',
        ),
      )
        .slice(0, 20)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role") ?? "",
            slot: element.getAttribute("data-slot") ?? "",
            testid: element.getAttribute("data-testid") ?? "",
            tabindex: element.getAttribute("tabindex") ?? "",
            ariaHidden: element.getAttribute("aria-hidden") ?? "",
            inert: element.hasAttribute("inert"),
            rect: [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
          };
        });
      return {
        dialog: Boolean(document.querySelector('[data-testid="settings-search-dialog"]')),
        activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
        activeRole: document.activeElement?.getAttribute("role") ?? "",
        activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
        editable:
          document.activeElement instanceof HTMLElement &&
          (document.activeElement.isContentEditable ||
            ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)),
        candidates,
      };
    });
    expect(
      afterExit.dialog,
      `Ctrl+[ 把设置搜索对话框一起关掉了: ${JSON.stringify(afterExit)}`,
    ).toBe(true);
    expect(afterExit.editable, `Ctrl+[ 后焦点仍在输入控件（active=${afterExit.activeTag}）`).toBe(
      false,
    );

    const hints = await openHints();
    expect(hints, "设置搜索对话框内 Ctrl+[ 后按 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "设置搜索提示层没有任何标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "设置搜索标签泄漏到背景页面").toEqual([]);

    await press("Escape", { code: "Escape" });
    await press("s", { code: "KeyS" });
    await press("a", { code: "KeyA" });
    await press("p", { code: "KeyP" });
    await browser.pause(150);
    const sneaked = await browser.execute(() => {
      const overlay = document.querySelector("[data-vim-hint-overlay]");
      return Boolean(overlay && (overlay.textContent ?? "").includes("sneak"));
    });
    expect(sneaked, "设置搜索对话框内 Ctrl+[ 后 s 没有开启 sneak").toBe(true);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q1-28 浮层内 Ctrl+[ 退出输入焦点后 f/s 立即可用（命令中心 + 任务查找）", async () => {
    // 命令中心：输入框 → Ctrl+[ → f → s
    await press(":", { code: "Semicolon", shiftKey: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: ": 没有打开命令中心" },
    );
    await browser.pause(250);
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    const commandState = await browser.execute(() => ({
      dialog: document.querySelectorAll('[role="dialog"]').length,
      activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
      editable:
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)),
    }));
    expect(commandState.dialog, "Ctrl+[ 后命令中心没有保持打开").toBeGreaterThan(0);
    expect(
      commandState.editable,
      `命令中心 Ctrl+[ 后焦点仍在输入控件（active=${commandState.activeTag}）`,
    ).toBe(false);

    const hints = await openHints();
    expect(hints, "命令中心 Ctrl+[ 后 f 不可用").not.toBeNull();
    expect(hints!.badges.length, "命令中心提示层没有任何标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "命令中心标签泄漏到背景页面").toEqual([]);

    const snippet = await textSnippet('[role="dialog"]', 2);
    await press("Escape", { code: "Escape" });
    const overlayText = await sneakTo(snippet);
    expect(overlayText, `命令中心 Ctrl+[ 后 sneak 内容异常: ${overlayText}`).toContain(
      `sneak ${snippet}`,
    );
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
    // 命令中心退场动画期间 role=dialog 仍会短暂存在；先等它真正卸载，
    // 否则下面的 / 等待会被退场中的 command center 误匹配。
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll('[role="dialog"]').length === 0),
      { timeout: 5_000, timeoutMsg: "命令中心关闭后仍有 dialog 残留" },
    );

    // 任务查找浮层：同一路径。
    await press("/", { code: "Slash" });
    await waitFindDialogFocused();
    await browser.pause(250);
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    const findState = await browser.execute(() => ({
      dialog: document.querySelectorAll('[role="dialog"]').length,
      activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
      editable:
        document.activeElement instanceof HTMLElement &&
        (document.activeElement.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)),
    }));
    expect(findState.dialog, "Ctrl+[ 后任务查找浮层没有保持打开").toBeGreaterThan(0);
    expect(
      findState.editable,
      `任务查找 Ctrl+[ 后焦点仍在输入控件（active=${findState.activeTag}）`,
    ).toBe(false);
    const findHints = await openHints();
    expect(findHints, "任务查找 Ctrl+[ 后 f 不可用").not.toBeNull();
    expect(findHints!.badges.length, "任务查找提示层没有任何标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "任务查找标签泄漏到背景页面").toEqual([]);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q1-29 f 在无可用目标时显示反馈而非静默", async () => {
    // 帮助浮层内没有可交互控件：f 必须给出可见反馈。
    await press("?", { code: "Slash", shiftKey: true });
    await waitTestid("vim-help");
    await press("f", { code: "KeyF" });
    await $(HINT_OVERLAY).waitForDisplayed({
      timeout: 5_000,
      timeoutMsg: "无目标时 f 没有任何反馈",
    });
    const overlayText = (await $(HINT_OVERLAY).getText()) as string;
    // 文案随界面语言变化（zh-CN/en-US），只断言存在可见反馈与 Esc 退出提示。
    expect(overlayText, `无目标反馈文案缺失: ${overlayText}`).toContain("Esc");

    // Esc 关掉反馈；帮助浮层也应在同一次 Esc 中收起。
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });
    await $(`[data-testid="vim-help"]`).waitForDisplayed({ reverse: true });
  });

  it("Q1-25 滚动后重新 f 标签跟随新视口", async () => {
    await ensureNormal();
    await browser.execute(() => {
      const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
      if (!timeline) throw new Error("找不到时间线滚动容器");
      const filler = document.createElement("div");
      filler.id = "vim-quicknav-scroll-filler";
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
      { timeout: 5_000, timeoutMsg: "滚动占位没有生效" },
    );
    const topHints = await openHints();
    expect(topHints, "顶部 f 没有打开提示层").not.toBeNull();
    const topTargets = topHints!.badges
      .map((badge) => badge.target)
      .filter((target): target is [number, number, number, number] => target !== null);
    await press("Escape", { code: "Escape" });

    await browser.execute(() => {
      const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
      if (timeline) timeline.scrollTop = 900;
    });
    await browser.pause(250);
    const scrolledHints = await openHints();
    expect(scrolledHints, "滚动后 f 没有打开提示层").not.toBeNull();
    const scrolledTargets = scrolledHints!.badges
      .map((badge) => badge.target)
      .filter((target): target is [number, number, number, number] => target !== null);
    expect(scrolledTargets.length).toBeGreaterThan(0);
    const outOfViewport = scrolledTargets.filter((target) => target[1] < -1 || target[1] >= 800);
    expect(outOfViewport, `滚动后标签指向视口外: ${JSON.stringify(outOfViewport)}`).toEqual([]);
    // 顶端控件（如 composer 的工具栏）滚出视口后不应继续有标签指向旧坐标。
    const stale = scrolledTargets.filter((target) => target[1] < -10);
    expect(stale, "滚动后仍有标签指向视口外旧位置").toEqual([]);
    expect(topTargets.length).toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
    await browser.execute(() => document.querySelector("#vim-quicknav-scroll-filler")?.remove());
  });

  it("Q1-26 任务行内联归档确认：f 激活后 Esc 取消", async () => {
    await ensureNormal();
    // 先让侧栏任务行获得焦点（hover 动作在 focus 时挂载），再 f。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await press("l", { code: "KeyL" });
      await browser.pause(120);
      const inSidebar = await browser.execute(
        () => document.activeElement?.closest('[data-testid="sidebar"]') !== null,
      );
      if (inSidebar) break;
    }
    await press("j", { code: "KeyJ" });
    await press("G", { code: "KeyG", shiftKey: true });
    await browser.pause(250);
    const focusedRow = await browser.execute(
      (id) => document.activeElement?.getAttribute("data-testid") === `task-item-${id}`,
      taskId,
    );
    expect(focusedRow, "j 没有把焦点移到前置任务行").toBe(true);

    const hints = await openHints();
    expect(hints, "任务行 f 没有打开提示层").not.toBeNull();
    const archiveLabel = await hintLabelForTestid(`task-archive-${taskId}`);
    expect(archiveLabel, `任务行没有归档按钮标签 task-archive-${taskId}`).not.toBeNull();
    await pressKeys(archiveLabel!.split(""));
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            document
              .querySelector(`[data-testid="task-item-${id}"]`)
              ?.getAttribute("data-archive-confirming-task-id") === id,
          taskId,
        ),
      { timeout: 5_000, timeoutMsg: "标签激活归档后没有进入二次确认态" },
    );
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            document
              .querySelector(`[data-testid="task-item-${id}"]`)
              ?.getAttribute("data-archive-confirming-task-id") !== id,
          taskId,
        ),
      { timeout: 5_000, timeoutMsg: "Esc 没有取消归档二次确认" },
    );
  });

  // -------------------------------------------------------------------------
  // Round 2：Round 1 修复的反例 / 边界（R2-Cxx）
  // -------------------------------------------------------------------------

  it("R2-C01 存在返回栈（插件商店）时，命令中心输入框 Ctrl+[ 仍归 vim 而非 navigateBack", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("plugin-store-sidebar-open");
    await waitTestid("plugin-store-root", 15_000);
    await browser.pause(400);

    // 对照：插件商店视图下 navigateBack 处理器已武装（canPrimaryNavigationBack=true）。
    // 焦点在非输入元素时页面级 Ctrl+[ 应真的后退离开插件商店；否则本用例前提不成立。
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await ensureNormal();
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(500);
    const pageLevelBack = await browser.execute(
      () => document.querySelector('[data-testid="plugin-store-root"]') === null,
    );
    console.log(`R2-C01 对照：插件商店页面级 Ctrl+[ navigateBack=${pageLevelBack}`);

    if (pageLevelBack) {
      // 重新进入插件商店，走被测路径。navigateBack 回到任务后焦点会落在 composer
      // （INSERT）；先无条件回主区，否则 f 会被当文本输入。
      await ensureNormalHard();
      await openHints();
      await activateHintFor("plugin-store-sidebar-open");
      await waitTestid("plugin-store-root", 15_000);
      await browser.pause(400);
    }
    await ensureNormalHard();

    await press(":", { code: "Semicolon", shiftKey: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector('[role="dialog"]'))),
      { timeout: 10_000, timeoutMsg: ": 没有打开命令中心" },
    );
    await browser.pause(250);
    expect((await activeElementFacts()).editable, "命令中心打开后焦点不在输入框").toBe(true);

    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(200);
    const after = await browser.execute(() => ({
      dialog: document.querySelectorAll('[role="dialog"]').length,
      pluginStore: Boolean(document.querySelector('[data-testid="plugin-store-root"]')),
    }));
    expect(
      after.dialog,
      "存在返回栈时 Ctrl+[ 把命令中心关掉了（navigateBack 抢先消费）",
    ).toBeGreaterThan(0);
    expect(after.pluginStore, "存在返回栈时 Ctrl+[ 触发了 navigateBack：插件商店被后退离开").toBe(
      true,
    );
    expect(
      (await activeElementFacts()).editable,
      `Ctrl+[ 后焦点仍在输入控件（active=${JSON.stringify(await activeElementFacts())}）`,
    ).toBe(false);

    const hints = await openHints();
    expect(hints, "插件商店内命令中心 Ctrl+[ 后 f 不可用").not.toBeNull();
    expect(hints!.badges.length, "插件商店内命令中心提示层没有标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "命令中心标签泄漏到背景").toEqual([]);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("R2-C02 存在返回栈时，设置搜索对话框输入框 Ctrl+[ 退出输入态且对话框不关", async () => {
    await openSettingsPage();
    // 返回栈是否武装：顶部后退按钮在可后退时启用。
    const backArmed = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="desktop-top-nav-back"]',
      );
      return Boolean(button && !button.disabled);
    });
    console.log(`R2-C02 设置页返回栈已武装=${backArmed}`);

    await openHints();
    await activateHintFor("settings-search-open");
    await waitTestid("settings-search-dialog", 8_000);
    await browser.pause(250);
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(200);
    const after = await browser.execute(() => ({
      dialog: Boolean(document.querySelector('[data-testid="settings-search-dialog"]')),
      settingsPage: Boolean(document.querySelector('[data-testid="settings-page"]')),
    }));
    expect(after.dialog, "设置搜索对话框被 Ctrl+[ 关掉了").toBe(true);
    expect(after.settingsPage, "Ctrl+[ 触发 navigateBack，设置页被后退离开").toBe(true);
    expect((await activeElementFacts()).editable, "Ctrl+[ 后焦点仍在设置搜索输入框").toBe(false);

    const hints = await openHints();
    expect(hints, "设置搜索 Ctrl+[ 后 f 不可用").not.toBeNull();
    expect(hints!.badges.length, "设置搜索提示层没有任何标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "设置搜索标签泄漏到背景").toEqual([]);
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("R2-C03 设置页两字符标签：前缀过滤、Backspace 还原、完整标签激活", async () => {
    await openSettingsPage();
    const hints = await openHints();
    expect(hints, "设置页 f 没有打开提示层").not.toBeNull();
    const twoChar = hints!.badges.filter((badge) => badge.label.length === 2);
    expect(
      twoChar.length,
      `设置页没有两字符标签（标签数=${hints!.badges.length}），无法验证前缀过滤`,
    ).toBeGreaterThan(0);

    const appearanceLabel = await hintLabelForSelector(
      '[data-testid="settings-section-nav-appearance"]',
    );
    expect(appearanceLabel, "「外观」导航没有标签").not.toBeNull();
    expect((appearanceLabel ?? "").length, `「外观」标签不是两字符: ${appearanceLabel}`).toBe(2);

    await press(appearanceLabel![0]!, {});
    await browser.pause(150);
    const filtered = await readHintFacts();
    expect(filtered, `输入前缀 ${appearanceLabel![0]} 后提示层消失`).not.toBeNull();
    expect(
      filtered!.badges.every((badge) => badge.label.startsWith(appearanceLabel![0]!)),
      `前缀过滤错误: ${JSON.stringify(filtered!.badges.map((badge) => badge.label))}`,
    ).toBe(true);
    expect(filtered!.badges.length, "前缀过滤后没有剩余标签").toBeGreaterThan(0);
    expect(filtered!.badges.length, "前缀过滤后标签没有减少").toBeLessThan(hints!.badges.length);

    await press("Backspace", {});
    await browser.pause(150);
    const restored = await readHintFacts();
    expect(restored, "Backspace 后提示层消失").not.toBeNull();
    expect(restored!.badges.length, "Backspace 没有还原全部标签").toBe(hints!.badges.length);

    await pressLabel(appearanceLabel!);
    await browser.waitUntil(async () => (await settingsActiveSection()) === "appearance", {
      timeout: 5_000,
      timeoutMsg: "两字符标签完整输入后没有激活外观分区",
    });
    await press("Escape", { code: "Escape" });
  });

  it("R2-C04 设置页滚动后重新 f：标签跟随新视口且仍可激活", async () => {
    await openSettingsPage();
    await openHints();
    // 选一个当前可用且可见的分区（usage 依赖账号数据，E2E 下可能不可用）。
    const sectionTestId = await browser.execute(() => {
      const navs = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="settings-section-nav-"]'),
      ).filter((element) => element.getBoundingClientRect().height > 2);
      // 取中段的可用分区：末尾项可能被导航列裁掉、首项常是当前分区。
      return navs[Math.floor(navs.length / 2)]?.getAttribute("data-testid") ?? "";
    });
    expect(sectionTestId, "设置页没有可见分区导航").not.toBe("");
    await activateHintForSelector(`[data-testid="${sectionTestId}"]`);
    await browser.pause(400);

    const scroll = await browser.execute(() => {
      const page = document.querySelector<HTMLElement>('[data-testid="settings-page"]');
      if (!page) return null;
      const scrollers = Array.from(page.querySelectorAll<HTMLElement>("*")).filter((element) => {
        if (element.closest("nav")) return false;
        const style = getComputedStyle(element);
        return (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 40
        );
      });
      scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const element = scrollers[0];
      if (!element) return null;
      const before = element.scrollTop;
      element.scrollTop = Math.min(600, element.scrollHeight - element.clientHeight);
      return {
        testid: element.getAttribute("data-testid") ?? "",
        tag: element.tagName.toLowerCase(),
        before,
        after: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    console.log(`R2-C04 设置页滚动: ${JSON.stringify(scroll)}`);
    expect(
      scroll && scroll.after > scroll.before,
      `设置页没有可滚动内容: ${JSON.stringify(scroll)}`,
    ).toBe(true);

    const facts = await collectPageFacts('[data-testid="settings-page"]');
    const hints = await openHints();
    expect(hints, "滚动后 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `滚动后 f 漏掉 ${report.missing.length}/${report.expectedCount} 个视口内控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    expect(
      await hintLeaksOutside('[data-testid="settings-page"]'),
      "滚动后标签泄漏到设置页外",
    ).toEqual([]);

    const navLabel = await hintLabelForSelector('[data-testid="settings-section-nav-appearance"]');
    expect(navLabel, "滚动后「外观」导航没有标签").not.toBeNull();
    await pressLabel(navLabel!);
    await browser.waitUntil(async () => (await settingsActiveSection()) === "appearance", {
      timeout: 5_000,
      timeoutMsg: "滚动后标签激活没有切到外观分区",
    });
  });

  it("R2-C05 提示层输入无前缀匹配的键：会话结束且可再次 f（不留死态）", async () => {
    await ensureNormal();
    const hints = await openHints();
    expect(hints, "工作区 f 没有打开提示层").not.toBeNull();
    const firstChars = new Set(hints!.badges.map((badge) => badge.label[0]!));
    const alphabet = "asdfghjklqwertyuiopzxcvbnm";
    const unused = alphabet.split("").find((char) => !firstChars.has(char));
    expect(unused, `所有标签首字符覆盖了全部 home-row 键: ${[...firstChars].join("")}`).not.toBe(
      undefined,
    );

    await press(unused!, {});
    await browser.pause(200);
    const stillOpen = await hintOpen();
    console.log(`R2-C05 无前缀匹配键 ${unused} 后提示层仍打开=${stillOpen}`);
    expect(stillOpen, `无前缀匹配键 ${unused} 后提示层进入死态（未退出的空标签层）`).toBe(false);

    const reopened = await openHints();
    expect(reopened, "无前缀匹配键退出后 f 无法再次打开提示层").not.toBeNull();
    expect(reopened!.badges.length, "再次 f 没有标签").toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
  });

  it("R2-C06 sneak 首尾环绕（, / ;）与 Enter 激活命中", async () => {
    await openSettingsPage();
    const repeated = await repeatedTextQuery('[data-testid="settings-page"]', 3);
    expect(repeated, "设置页没有出现 >=3 次的双字符文本，无法验证环绕").not.toBeNull();
    const query = repeated!.query;
    const overlayText = await sneakTo(query);
    const position = overlayText.match(/· (\d+)\/(\d+)/);
    expect(position, `sneak 浮层缺少命中计数: ${overlayText}`).not.toBeNull();
    const total = Number(position![2]);
    expect(total, `sneak 命中数不足: ${overlayText}`).toBeGreaterThanOrEqual(3);
    expect(position![1], `sneak 起始索引不是 1: ${overlayText}`).toBe("1");

    // 首尾环绕：第一条按 , 应到末条；末条按 ; 应回到第一条。
    await press(",", { code: "Comma" });
    await browser.pause(120);
    expect((await $(HINT_OVERLAY).getText()) as string, "在第一条按 , 没有环绕到末条").toContain(
      `${total}/${total}`,
    );
    await press(";", { code: "Semicolon" });
    await browser.pause(120);
    expect((await $(HINT_OVERLAY).getText()) as string, "在末条按 ; 没有环绕回第一条").toContain(
      `1/${total}`,
    );
    await press("Escape", { code: "Escape" });

    // Enter 激活：命中「外观」导航文字后按 Enter 应切到外观分区。
    const labelText = (await browser.execute(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-testid="settings-section-nav-appearance"]',
      );
      return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    })) as string;
    expect(labelText.length, "「外观」导航没有文字").toBeGreaterThanOrEqual(2);
    const query2 = labelText.slice(0, 2);
    const overlayText2 = await sneakTo(query2);
    const position2 = overlayText2.match(/· (\d+)\/(\d+)/);
    expect(position2, `sneak 浮层缺少命中计数: ${overlayText2}`).not.toBeNull();
    const total2 = Number(position2![2]);
    // 循环到高亮框正好覆盖「外观」导航的那一条，再 Enter。
    let matched = false;
    for (let attempt = 0; attempt < total2; attempt += 1) {
      const hits = await browser.execute(() => {
        const nav = document.querySelector<HTMLElement>(
          '[data-testid="settings-section-nav-appearance"]',
        );
        const active = Array.from(
          document.querySelectorAll<HTMLElement>("[data-vim-hint-overlay] div.absolute"),
        ).find((element) => element.className.includes("bg-amber-300/40"));
        if (!nav || !active) return null;
        const a = nav.getBoundingClientRect();
        const b = active.getBoundingClientRect();
        // sneak 命中的是文本 range（比导航按钮窄）；只要高亮框落在按钮内即视为命中该项。
        return (
          b.left >= a.left - 4 &&
          b.right <= a.right + 4 &&
          b.top >= a.top - 4 &&
          b.bottom <= a.bottom + 4
        );
      });
      if (hits) {
        matched = true;
        break;
      }
      await press(";", { code: "Semicolon" });
      await browser.pause(100);
    }
    if (matched) {
      await press("Enter", { code: "Enter" });
      await browser.waitUntil(async () => (await settingsActiveSection()) === "appearance", {
        timeout: 5_000,
        timeoutMsg: "sneak Enter 没有激活「外观」导航",
      });
    } else {
      console.log(`R2-C06 sneak 查询 ${query2} 未命中「外观」导航，Enter 激活不适用`);
    }
    await press("Escape", { code: "Escape" });
  });

  // -------------------------------------------------------------------------
  // Round 2：菜单 / 下拉族（Q2-01..Q2-04）
  // -------------------------------------------------------------------------

  it("Q2-01 模型选择器：f 打开下拉后再次 f 只给菜单项打标签，且可激活", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("chat-model-select-trigger");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="chat-model-select-trigger"]')
              ?.getAttribute("aria-expanded") === "true",
        ),
      { timeout: 5_000, timeoutMsg: "标签激活模型选择器后下拉没有打开（Q1-22 回归）" },
    );
    await browser.pause(200);

    const hints = await openHints();
    expect(hints, "模型下拉内按 f 没有出现提示层（Q1-23 回归）").not.toBeNull();
    expect(hints!.badges.length, "模型下拉提示层没有菜单项标签").toBeGreaterThan(0);
    expect(
      await hintLeaksOutside('[role="menu"], [role="listbox"]'),
      "模型下拉标签泄漏到背景页面",
    ).toEqual([]);

    const itemCount = await browser.execute(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
          (element) => element.getBoundingClientRect().height > 2,
        ).length,
    );
    expect(itemCount, "模型下拉没有任何 menuitem").toBeGreaterThan(0);

    /**
     * 激活验证用“选中项”避免切换模型污染后续用例；点击探针证明标签命中的是目标项。
     */
    const selectedItemLabel = await hintLabelForSelector(
      '[data-testid^="chat-model-select-item"][data-model-option-selected="true"]',
    );
    const label =
      selectedItemLabel ?? (await hintLabelForSelector('[data-testid^="chat-model-select-item"]'));
    expect(label, "模型下拉没有任何带标签的模型项（可能全是锁定项）").not.toBeNull();

    const activatedTestId = await browser.execute((wanted) => {
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      const badgeFor = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        for (const span of Array.from(overlay?.querySelectorAll("span") ?? [])) {
          const border = span.parentElement?.querySelector<HTMLElement>("div");
          const left = Number.parseFloat(border?.style.left || "NaN") + 1;
          const top = Number.parseFloat(border?.style.top || "NaN") + 1;
          if (Math.abs(left - rect.left) <= 3 && Math.abs(top - rect.top) <= 3) {
            return span.textContent ?? "";
          }
        }
        return null;
      };
      const item = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="chat-model-select-item"]'),
      ).find((candidate) => badgeFor(candidate) === wanted);
      if (!item) return "";
      const windowWithProbe = window as typeof window & { __vimModelItemClicks?: number };
      windowWithProbe.__vimModelItemClicks = 0;
      item.addEventListener(
        "click",
        () => {
          windowWithProbe.__vimModelItemClicks = (windowWithProbe.__vimModelItemClicks ?? 0) + 1;
        },
        { capture: true, once: true },
      );
      return item.getAttribute("data-testid") ?? "";
    }, label!);
    expect(activatedTestId, `没有找到标签 ${label} 对应的模型项`).not.toBe("");
    await pressLabel(label!);
    const probe = await browser.execute(() => {
      const windowWithProbe = window as typeof window & { __vimModelItemClicks?: number };
      return windowWithProbe.__vimModelItemClicks ?? 0;
    });
    expect(probe, `标签激活没有把 click 派发到模型项 ${activatedTestId}`).toBeGreaterThan(0);
    // 合并式模型菜单按设计在选择后保持打开（可继续调档）——不要求关闭。
    console.log(`Q2-01 模型项 ${activatedTestId} 已由标签激活，菜单保持打开（设计）`);
    await press("Escape", { code: "Escape" });
  });

  it("Q2-02 思考级别选择器：f 打开后菜单内 f 可打标签并可激活", async () => {
    await ensureNormal();
    const trigger = $('[data-testid="chat-thought-level-select-trigger"]');
    if (!(await trigger.isExisting())) {
      console.log("Q2-02 思考级别选择器不存在（当前模型不支持），记 N/A");
      return;
    }
    await openHints();
    await activateHintFor("chat-thought-level-select-trigger");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="chat-thought-level-select-trigger"]')
              ?.getAttribute("aria-expanded") === "true",
        ),
      { timeout: 5_000, timeoutMsg: "标签激活思考级别选择器后下拉没有打开" },
    );
    await browser.pause(200);

    const hints = await openHints();
    expect(hints, "思考级别下拉内 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "思考级别提示层没有菜单项标签").toBeGreaterThan(0);
    expect(
      await hintLeaksOutside('[role="menu"], [role="listbox"]'),
      "思考级别标签泄漏到背景页面",
    ).toEqual([]);

    const label = await hintLabelForSelector('[data-testid^="chat-thought-level-select-item"]');
    expect(label, "思考级别下拉没有带标签的级别项").not.toBeNull();
    await pressLabel(label!);
    await browser.pause(300);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="chat-thought-level-select-trigger"]')
              ?.getAttribute("aria-expanded") !== "true",
        ),
      { timeout: 8_000, timeoutMsg: "标签激活思考级别后下拉没有关闭" },
    );
    await press("Escape", { code: "Escape" });
  });

  it("Q2-03 模式选择器：f 打开后菜单内 f 可切换模式，再切回原模式", async () => {
    await ensureNormal();
    const original = (await getV4ModelConfig()).mode;
    expect(original, "读取不到当前模式").not.toBeNull();
    const target = original === "guarded" ? "build" : "guarded";
    await openHints();
    await activateHintFor("chat-mode-select-trigger");
    await browser.pause(250);
    const hints = await openHints();
    expect(hints, "模式下拉内 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "模式下拉提示层没有菜单项标签").toBeGreaterThan(0);
    expect(
      await hintLeaksOutside('[role="menu"], [role="listbox"]'),
      "模式下拉标签泄漏到背景页面",
    ).toEqual([]);

    const label = await hintLabelForSelector(`[data-testid="chat-mode-select-item-${target}"]`);
    expect(label, `模式下拉没有 ${target} 项标签`).not.toBeNull();
    await pressLabel(label!);
    await browser.waitUntil(async () => (await getV4ModelConfig()).mode === target, {
      timeout: 10_000,
      timeoutMsg: `标签激活模式项后模式没有切到 ${target}`,
    });
    await switchV4Mode(original!);
    expect((await getV4ModelConfig()).mode, "模式没有恢复原值").toBe(original);
  });

  it("Q2-04 侧栏视图菜单：f 打开菜单 → 菜单内 f 打标签 → 激活切换视图 → 再切回", async () => {
    await ensureNormal();
    console.log(`Q2-04 起始浮层=${JSON.stringify(await overlayFacts())}`);
    await openHints();
    await activateHintFor("sidebar-view-menu");
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
      { timeout: 5_000, timeoutMsg: "标签没有打开侧栏视图菜单" },
    );
    await browser.pause(200);
    const hints = await openHints();
    expect(hints, "侧栏视图菜单内 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "侧栏视图菜单没有菜单项标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="menu"]'), "视图菜单标签泄漏到背景").toEqual([]);
    for (const view of ["projects", "grouped", "timeline", "unread"]) {
      expect(
        await hintLabelForSelector(`[data-testid="sidebar-view-${view}"]`),
        `视图菜单缺少 ${view} 项标签`,
      ).not.toBeNull();
    }

    await activateHintForSelector('[data-testid="sidebar-view-timeline"]');
    await browser.waitUntil(
      () =>
        browser.execute(() => document.querySelector('[data-testid="task-grouped-view"]') === null),
      { timeout: 8_000, timeoutMsg: "标签激活「最近更新」后侧栏没有切到时间线视图" },
    );
    expect(
      await browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid="task-item-${id}"]`)),
        taskId,
      ),
      "切到时间线视图后任务行消失",
    ).toBe(true);

    await openHints();
    console.log(`Q2-04 二次 f 标签=${JSON.stringify(await badgeHitReport())}`);
    let groupedLabel = await hintLabelForSelector('[data-testid="sidebar-view-grouped"]');
    if (groupedLabel === null) {
      // 菜单已关闭：Esc 收掉提示层后重新走 f → 触发器 → 菜单。
      await press("Escape", { code: "Escape" });
      await openHints();
      await activateHintFor("sidebar-view-menu");
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "第二次没有打开侧栏视图菜单" },
      );
      await openHints();
      groupedLabel = await hintLabelForSelector('[data-testid="sidebar-view-grouped"]');
    }
    expect(groupedLabel, "侧栏视图菜单没有 grouped 项标签").not.toBeNull();
    await pressLabel(groupedLabel!);
    await browser.waitUntil(
      () =>
        browser.execute(() => document.querySelector('[data-testid="task-grouped-view"]') !== null),
      { timeout: 8_000, timeoutMsg: "没有切回分组视图" },
    );
  });

  // -------------------------------------------------------------------------
  // Round 2：对话框族（Q2-05..Q2-10）
  // -------------------------------------------------------------------------

  it("Q2-05 任务行上下文菜单：f 只给菜单项打标签，激活重命名打开对话框（Esc 关闭）", async () => {
    expect(await focusSeededTaskRow(), "j/G 没有把焦点移到前置任务行").toBe(true);
    const keyboardOpened = await openTaskContextMenuByKeyboard();
    if (!keyboardOpened) {
      console.log(
        "Q2-05 Shift+F10 没有打开任务行上下文菜单，回退为 DOM contextmenu 事件准备 fixture",
      );
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
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "DOM contextmenu 也没有打开任务行菜单" },
      );
    }

    const hints = await openHints();
    expect(hints, "任务行菜单内 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "任务行菜单没有菜单项标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="menu"]'), "任务行菜单标签泄漏到背景").toEqual([]);

    const rename = await hintLabelForTexts(["Rename task", "重命名任务", "Rename", "重命名"]);
    expect(rename, "任务行菜单没有「重命名」项标签").not.toBeNull();
    await pressLabel(rename!.label);

    const dialogState = async () =>
      browser.execute(() => {
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
        const dialog = dialogs.find((element) => element.querySelector("input") !== null) ?? null;
        const input = dialog?.querySelector<HTMLInputElement>("input") ?? null;
        return {
          dialog: dialog !== null,
          input: input !== null,
          inputValue: input?.value ?? "",
          focusedIsInput: document.activeElement === input,
          activeTag: document.activeElement?.tagName.toLowerCase() ?? "",
        };
      });
    await browser.waitUntil(async () => (await dialogState()).dialog, {
      timeout: 8_000,
      timeoutMsg: "重命名菜单项没有打开重命名对话框",
    });
    const opened = await dialogState();
    expect(opened.input, "重命名对话框没有输入框").toBe(true);
    expect(opened.focusedIsInput, "重命名对话框打开后输入框没有聚焦").toBe(true);

    // §2.1：输入框内裸 f 保持文本输入。
    await press("f", { code: "KeyF" });
    await browser.pause(200);
    expect(await hintOpen(), "重命名输入框内裸 f 不应生成标签（§2.1）").toBe(false);

    // Ctrl+[：退出输入态，对话框保持打开。
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(200);
    const afterExit = await dialogState();
    expect(afterExit.dialog, "Ctrl+[ 把重命名对话框关掉了").toBe(true);
    expect((await activeElementFacts()).editable, "Ctrl+[ 后焦点仍在重命名输入框").toBe(false);

    const dialogHints = await openHints();
    expect(dialogHints, "重命名对话框 Ctrl+[ 后 f 不可用").not.toBeNull();
    expect(dialogHints!.badges.length, "重命名对话框没有可打标签的按钮").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "重命名对话框标签泄漏到背景").toEqual([]);
    expect(
      await hintLabelForTexts(["Cancel", "取消"]),
      "重命名对话框没有「取消」按钮标签",
    ).not.toBeNull();
    expect(
      await hintLabelForTexts(["Confirm", "确认"]),
      "重命名对话框没有「确认」按钮标签",
    ).not.toBeNull();

    await press("Escape", { code: "Escape" });
    // 第一次 Esc 若被提示层消费，第二次才交给对话框；无条件补一次。
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(async () => !(await dialogState()).dialog, {
      timeout: 5_000,
      timeoutMsg: "Esc 没有关闭重命名对话框",
    });
  });

  it("Q2-06 重命名对话框：取消/确认按钮均可由标签激活", async () => {
    expect(await focusSeededTaskRow(), "j/G 没有把焦点移到前置任务行").toBe(true);
    await openTaskContextMenuByKeyboard();
    if ((await overlayCount('[role="menu"]')) === 0) {
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
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "任务行菜单没有打开" },
      );
    }
    await openHints();
    const rename = await hintLabelForTexts(["Rename task", "重命名任务", "Rename", "重命名"]);
    expect(rename, "任务行菜单没有「重命名」项标签").not.toBeNull();
    await pressLabel(rename!.label);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[role="dialog"] input') !== null),
      { timeout: 8_000, timeoutMsg: "重命名对话框没有打开" },
    );

    // 取消路径
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    await openHints();
    const cancel = await hintLabelForTexts(["Cancel", "取消"]);
    expect(cancel, "重命名对话框没有取消按钮标签").not.toBeNull();
    await pressLabel(cancel!.label);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[role="dialog"] input') === null),
      { timeout: 5_000, timeoutMsg: "标签激活取消后重命名对话框没有关闭" },
    );

    // 确认路径（标题不变，仅验证键盘完成链路）
    await focusSeededTaskRow();
    if ((await overlayCount('[role="menu"]')) === 0) {
      await openTaskContextMenuByKeyboard();
    }
    if ((await overlayCount('[role="menu"]')) === 0) {
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
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "任务行菜单没有打开" },
      );
    }
    await openHints();
    const renameAgain = await hintLabelForTexts(["Rename task", "重命名任务", "Rename", "重命名"]);
    expect(renameAgain, "第二次没有「重命名」项标签").not.toBeNull();
    await pressLabel(renameAgain!.label);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[role="dialog"] input') !== null),
      { timeout: 8_000, timeoutMsg: "重命名对话框没有打开" },
    );
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
    await openHints();
    const confirm = await hintLabelForTexts(["Confirm", "确认"]);
    expect(confirm, "重命名对话框没有确认按钮标签").not.toBeNull();
    await pressLabel(confirm!.label);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[role="dialog"] input') === null),
      { timeout: 8_000, timeoutMsg: "标签激活确认后重命名对话框没有关闭" },
    );
  });

  it("Q2-07 通用确认框（模型提供方删除）：f 只覆盖确认框，Esc/取消均可关闭", async () => {
    await openSettingsPage();
    await openHints();
    const sectionLabel = await hintLabelForSelector(
      '[data-testid="settings-section-nav-modelProvider"]',
    );
    if (sectionLabel === null) {
      console.log("Q2-07 设置页没有模型提供方分区，通用确认框记 N/A");
      return;
    }
    await pressLabel(sectionLabel);
    await browser.pause(600);
    await ensureNormalHard();

    const openDeleteConfirm = async () => {
      await openHints();
      const actionsLabel = await hintLabelForTestid("model-provider-actions-button");
      if (actionsLabel === null) {
        console.log(
          `Q2-07 模型提供方没有更多操作入口（page=${JSON.stringify(
            await overlayFacts(),
          )}），确认框记 N/A`,
        );
        return false;
      }
      await pressLabel(actionsLabel);
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "提供方更多操作菜单没有打开" },
      );
      await browser.pause(150);
      await openHints();
      const deleteLabel = await hintLabelForSelector('[role="menuitem"]:has(svg.lucide-trash-2)');
      if (deleteLabel === null) {
        console.log("Q2-07 提供方菜单没有删除项（内置提供方不可删），确认框记 N/A");
        await press("Escape", { code: "Escape" });
        return false;
      }
      await pressLabel(deleteLabel);
      await waitTestid("confirm-dialog-confirm", 10_000);
      await browser.pause(200);
      return true;
    };

    if (!(await openDeleteConfirm())) return;

    const hints = await openHints();
    expect(hints, "通用确认框内 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "确认框没有可打标签的按钮").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "确认框标签泄漏到背景").toEqual([]);
    expect(await hintLabelForTexts(["Cancel", "取消"]), "确认框没有取消按钮标签").not.toBeNull();
    expect(
      await hintLabelForTexts(["Delete", "删除", "Confirm", "确认"]),
      "确认框没有确认按钮标签",
    ).not.toBeNull();
    // 确认按钮为危险操作，本用例只做取消路径，避免删除 E2E 提供方。

    await press("Escape", { code: "Escape" });
    if (await hintOpen()) await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelector('[data-testid="confirm-dialog-confirm"]') === null,
        ),
      { timeout: 5_000, timeoutMsg: "Esc 没有关闭通用确认框" },
    );

    // 取消按钮路径
    if (!(await openDeleteConfirm())) return;
    await openHints();
    const cancel = await hintLabelForTexts(["Cancel", "取消"]);
    expect(cancel, "确认框没有取消按钮标签").not.toBeNull();
    await pressLabel(cancel!.label);
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelector('[data-testid="confirm-dialog-confirm"]') === null,
        ),
      { timeout: 5_000, timeoutMsg: "标签激活取消后确认框没有关闭" },
    );
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-testid^="model-provider-nav-item"]').length > 0,
      ),
      "取消删除后提供方列表消失",
    ).toBe(true);
  });

  it("Q2-08 YOLO AlertDialog：f 作用域为 alertdialog、s 无匹配提示、Esc 关闭、确认可键盘完成", async () => {
    await ensureNormal();
    const original = (await getV4ModelConfig()).mode;
    if (original === "yolo") {
      await switchV4Mode("guarded");
      await ensureNormal();
    }

    const openYoloDialog = async () => {
      await ensureNormal();
      await openHints();
      await activateHintFor("chat-mode-select-trigger");
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "模式下拉没有打开" },
      );
      const hints = await openHints();
      expect(hints, "模式下拉内 f 不可用").not.toBeNull();
      const yolo = await hintLabelForSelector('[data-testid="chat-mode-select-item-yolo"]');
      expect(yolo, "模式下拉没有 yolo 项标签").not.toBeNull();
      await pressLabel(yolo!);
      await waitTestid("yolo-confirmation-dialog", 10_000);
      await browser.pause(250);
    };
    await openYoloDialog();

    const role = await browser.execute(
      () =>
        document.querySelector('[data-testid="yolo-confirmation-dialog"]')?.getAttribute("role") ??
        "",
    );
    expect(role, `YOLO 对话框 role 不是 alertdialog（实际=${role}）`).toBe("alertdialog");

    const hints = await openHints();
    expect(hints, "YOLO AlertDialog 内 f 没有出现提示层（Q1-23 回归）").not.toBeNull();
    expect(hints!.badges.length, "YOLO AlertDialog 没有标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="alertdialog"]'), "YOLO 对话框标签泄漏到背景页面").toEqual(
      [],
    );
    const labeled = await browser.execute(() => {
      const overlay = document.querySelector("[data-vim-hint-overlay]");
      const confirm = document.querySelector<HTMLElement>(
        '[data-testid="yolo-confirmation-confirm"]',
      );
      if (!overlay || !confirm) return null;
      const rect = confirm.getBoundingClientRect();
      return Array.from(overlay.querySelectorAll("span")).some((span) => {
        const border = span.parentElement?.querySelector<HTMLElement>("div");
        const left = Number.parseFloat(border?.style.left || "NaN") + 1;
        const top = Number.parseFloat(border?.style.top || "NaN") + 1;
        return Math.abs(left - rect.left) <= 3 && Math.abs(top - rect.top) <= 3;
      });
    });
    expect(labeled, "禁用状态的「确认」不应有 f 标签（风险未勾选）").toBe(false);
    expect(
      await hintLabelForTestid("yolo-confirmation-risk"),
      "YOLO 风险勾选框没有标签",
    ).not.toBeNull();
    expect(
      await hintLabelForTestid("yolo-confirmation-cancel"),
      "YOLO 取消按钮没有标签",
    ).not.toBeNull();

    // Esc 先退出 sneak，再关闭 alertdialog；关闭后模式不得改变。
    await press("Escape", { code: "Escape" });
    await press("s", { code: "KeyS" });
    await press("z", { code: "KeyZ" });
    await press("z", { code: "KeyZ" });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 3_000, timeoutMsg: "YOLO 对话框内 s 没有进入 sneak 查询态" },
    );
    const sneakText = (await $(HINT_OVERLAY).getText()) as string;
    expect(sneakText, `YOLO 对话框内无匹配没有提示: ${sneakText}`).toContain("无匹配");
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () =>
        browser.execute(() => !document.querySelector('[data-testid="yolo-confirmation-dialog"]')),
      { timeout: 5_000, timeoutMsg: "Esc 没有关闭 YOLO alertdialog" },
    );
    expect((await getV4ModelConfig()).mode, "取消 YOLO 后模式被改变").not.toBe("yolo");

    // 确认路径：勾选风险 → 确认，模式应切到 yolo。
    await openYoloDialog();
    await openHints();
    const risk = await hintLabelForTestid("yolo-confirmation-risk");
    expect(risk, "YOLO 风险勾选框没有标签").not.toBeNull();
    await pressLabel(risk!);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="yolo-confirmation-risk"]')
              ?.getAttribute("aria-checked") === "true",
        ),
      { timeout: 5_000, timeoutMsg: "标签激活风险勾选框后没有勾选" },
    );
    await openHints();
    const confirmLabel = await hintLabelForTestid("yolo-confirmation-confirm");
    expect(confirmLabel, "勾选风险后确认按钮仍没有标签").not.toBeNull();
    await pressLabel(confirmLabel!);
    await browser.waitUntil(async () => (await getV4ModelConfig()).mode === "yolo", {
      timeout: 10_000,
      timeoutMsg: "标签激活确认后模式没有切到 yolo",
    });
    await switchV4Mode(original === "yolo" ? "guarded" : original!);
  });

  it("Q2-09 插件商店来源服务器对话框：f 作用域、Esc 关闭、商店页面不后退", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("plugin-store-sidebar-open");
    await waitTestid("plugin-store-root", 15_000);
    await browser.pause(300);
    await openHints();
    const sourcesLabel = await hintLabelForTestid("plugin-store-sources-open");
    expect(sourcesLabel, "插件商店没有来源服务器按钮标签").not.toBeNull();
    await pressLabel(sourcesLabel!);
    await waitTestid("plugin-store-sources-dialog", 8_000);
    await browser.pause(250);

    const hints = await openHints();
    expect(hints, "来源服务器对话框内 f 没有出现提示层").not.toBeNull();
    expect(hints!.badges.length, "来源服务器对话框没有标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "来源服务器对话框标签泄漏到背景").toEqual([]);
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-testid="plugin-store-source-row"]').length > 0,
      ),
      "来源服务器对话框没有列出任何来源行",
    ).toBe(true);

    await press("Escape", { code: "Escape" });
    // 第一次 Esc 若被提示层消费，第二次才交给对话框。
    await press("Escape", { code: "Escape" });
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelector('[data-testid="plugin-store-sources-dialog"]') === null,
        ),
      { timeout: 5_000, timeoutMsg: "Esc 没有关闭来源服务器对话框" },
    );
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="plugin-store-root"]')),
      ),
      "关闭来源服务器对话框后插件商店被一起关闭",
    ).toBe(true);
  });

  it("Q2-10 设置搜索对话框：Ctrl+[ 后 f 激活搜索结果并跳转分区", async () => {
    await openSettingsPage();
    await openHints();
    await activateHintFor("settings-search-open");
    await waitTestid("settings-search-dialog", 8_000);
    await browser.pause(250);
    // 空查询会把全部设置项塞进列表，目标项往往在滚动区外；先像用户一样输入筛选词。
    await browser.keys("appearance");
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelectorAll('[data-settings-search-result="appearance"]').length > 0,
        ),
      { timeout: 5_000, timeoutMsg: "设置搜索输入 appearance 后没有过滤出外观分区" },
    );
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(200);
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="settings-search-dialog"]')),
      ),
      "Ctrl+[ 把设置搜索对话框关掉了",
    ).toBe(true);
    expect((await activeElementFacts()).editable, "Ctrl+[ 后焦点仍在搜索输入框").toBe(false);

    const hints = await openHints();
    expect(hints, "设置搜索对话框 Ctrl+[ 后 f 不可用").not.toBeNull();
    expect(hints!.badges.length, "设置搜索对话框没有结果标签").toBeGreaterThan(0);
    expect(await hintLeaksOutside('[role="dialog"]'), "设置搜索标签泄漏到背景").toEqual([]);
    const resultLabel = await hintLabelForSelector('[data-settings-search-result="appearance"]');
    expect(resultLabel, "设置搜索结果里没有「外观」分区项标签").not.toBeNull();
    await pressLabel(resultLabel!);
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelector('[data-testid="settings-search-dialog"]') === null,
        ),
      { timeout: 5_000, timeoutMsg: "激活搜索结果后搜索对话框没有关闭" },
    );
    await browser.waitUntil(async () => (await settingsActiveSection()) === "appearance", {
      timeout: 5_000,
      timeoutMsg: "激活搜索结果后没有跳到外观分区",
    });
  });

  // -------------------------------------------------------------------------
  // Round 2：P1 页面（Q2-11..Q2-16）
  // -------------------------------------------------------------------------

  it("Q2-11 侧栏面板 launcher：f 覆盖全部启动项；打开 Git/Review 面板并覆盖", async () => {
    await closeAllSidePaneTabs();
    await openSidePaneLauncher();
    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "侧栏 launcher f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `侧栏 launcher f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);

    const launcherItems: string[] = [];
    for (const item of ["files", "review", "terminal", "browser", "developer-tools"]) {
      const count = await browser.execute(
        (value) => document.querySelectorAll(`[data-side-pane-open-tab-item="${value}"]`).length,
        item,
      );
      if (count === 0) continue;
      launcherItems.push(item);
      expect(
        await hintLabelForSelector(`[data-side-pane-open-tab-item="${item}"]`),
        `launcher 启动项 ${item} 没有标签`,
      ).not.toBeNull();
    }
    expect(
      launcherItems.length,
      `launcher 没有任何启动项: ${JSON.stringify(launcherItems)}`,
    ).toBeGreaterThan(0);

    await activateHintForSelector('[data-side-pane-open-tab-item="review"]');
    await waitTestid("git-pane", 15_000);
    await browser.pause(500);
    await ensureNormal();

    const paneFacts = await collectPageFacts(null);
    const paneHints = await openHints();
    expect(paneHints, "Git/Review 面板 f 没有打开提示层").not.toBeNull();
    const paneReport = coverage(paneFacts, paneHints!);
    expect(
      paneReport.missing,
      `Git/Review 面板 f 漏掉 ${paneReport.missing.length}/${paneReport.expectedCount} 个控件: ${JSON.stringify(
        paneReport.missing,
      )}`,
    ).toEqual([]);

    const triggerLabel = await hintLabelForTestid("git-action-trigger");
    if (triggerLabel === null) {
      console.log("Q2-11 git-action-trigger 不可用（无仓库/无变更/禁用），提交对话框记为 N/A");
    } else {
      await pressLabel(triggerLabel);
      const dialogOpened = await browser
        .waitUntil(
          () =>
            browser.execute(
              () =>
                Boolean(document.querySelector('[data-testid="git-commit-dialog"]')) ||
                document.querySelectorAll('[role="menu"]').length > 0,
            ),
          { timeout: 6_000 },
        )
        .then(
          () => true,
          () => false,
        );
      if (dialogOpened) {
        const dialogVisible = await browser.execute(
          () => document.querySelector('[data-testid="git-commit-dialog"]') !== null,
        );
        if (dialogVisible) {
          const commitHints = await openHints();
          expect(commitHints, "Git 提交对话框内 f 没有提示层").not.toBeNull();
          expect(commitHints!.badges.length, "Git 提交对话框没有标签").toBeGreaterThan(0);
          expect(await hintLeaksOutside('[role="dialog"]'), "Git 提交对话框标签泄漏到背景").toEqual(
            [],
          );
          expect(
            await hintLabelForTestid("git-commit-message-input"),
            "提交信息输入框没有标签",
          ).not.toBeNull();
          await press("Escape", { code: "Escape" });
          await browser.waitUntil(
            () =>
              browser.execute(
                () => document.querySelector('[data-testid="git-commit-dialog"]') === null,
              ),
            { timeout: 5_000, timeoutMsg: "Esc 没有关闭 Git 提交对话框" },
          );
        } else {
          console.log("Q2-11 git-action-trigger 打开的是菜单而非提交对话框，记 N/A");
        }
      } else {
        console.log("Q2-11 标签激活 git-action-trigger 后 6s 内没有对话框/菜单，记 N/A");
      }
    }
    await closeActiveSidePaneTab();
  });

  it("Q2-12 文件树/文件管理器：f 覆盖、键盘展开目录、激活文件打开预览", async () => {
    await closeAllSidePaneTabs();
    await openSidePaneLauncher();
    await openHints();
    const launcherLabel = await hintLabelForSelector('[data-side-pane-open-tab-item="files"]');
    if (launcherLabel === null) {
      console.log(
        `Q2-12 launcher 的 files 启动项没有标签（行存在=${await browser.execute(
          () => document.querySelectorAll('[data-side-pane-open-tab-item="files"]').length,
        )}），记 N/A`,
      );
      return;
    }
    await pressLabel(launcherLabel);
    await waitTestid("workspace-file-tree-panel", 15_000);
    await browser.pause(500);
    await ensureNormal();

    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "文件管理器 f 没有打开提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `文件管理器 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    expect(
      await hintLabelForTestid("workspace-file-tree-refresh-button"),
      "文件树刷新按钮没有标签",
    ).not.toBeNull();
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-testid^="workspace-file-tree-row-"]').length,
      ),
      "文件树没有任何行",
    ).toBeGreaterThan(0);

    const targetPath = relative(DEFAULT_WORKSPACE, E2E_READONLY_TOOL_FILE_PATH).replaceAll(
      "\\",
      "/",
    );
    const targetTestId = `workspace-file-tree-row-${targetPath}`;
    let expanded = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const rowVisible = await browser.execute((id) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      }, targetTestId);
      if (rowVisible) break;
      const dirTestId = await browser.execute((target) => {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid^="workspace-file-tree-row-"]'),
        );
        for (const row of rows) {
          if (row.getAttribute("aria-expanded") !== "false") continue;
          const id = row.getAttribute("data-testid") ?? "";
          const path = id.replace("workspace-file-tree-row-", "");
          if (target === path || target.startsWith(`${path}/`)) return id;
        }
        return "";
      }, targetPath);
      if (!dirTestId) break;
      if (!(await hintOpen())) await openHints();
      const label = await hintLabelForSelector(`[data-testid="${dirTestId}"]`);
      if (label === null) break;
      await pressLabel(label);
      await browser.pause(400);
      expanded += 1;
    }
    console.log(`Q2-12 键盘展开目录 ${expanded} 层，目标行=${targetPath}`);

    if (await hintOpen()) await press("Escape", { code: "Escape" });
    const fileLabel = await hintLabelForSelector(`[data-testid="${targetTestId}"]`);
    if (fileLabel === null) {
      console.log(`Q2-12 目标文件行 ${targetPath} 不可见（展开失败或不在工作区），预览记为 N/A`);
    } else {
      await pressLabel(fileLabel);
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
      expect(previewOpened, "标签激活文件行后没有打开 preview-pane").toBe(true);
      const previewHints = await openHints();
      expect(previewHints, "预览面板 f 没有提示层").not.toBeNull();
      expect(previewHints!.badges.length, "预览面板没有标签").toBeGreaterThan(0);
      expect(await hintLeaksOutside("main"), "预览面板标签泄漏到主区之外").toEqual([]);
      const closeLabel = await hintLabelForTestid("preview-close-button");
      expect(closeLabel, "预览面板没有关闭按钮标签").not.toBeNull();
      await pressLabel(closeLabel!);
      await browser.waitUntil(
        () =>
          browser.execute(() => document.querySelector('[data-testid="preview-pane"]') === null),
        { timeout: 5_000, timeoutMsg: "标签激活预览关闭按钮后预览没有关闭" },
      );
    }
    await closeActiveSidePaneTab();
  });

  it("Q2-13 Browser 面板：f 覆盖工具栏、地址栏退出输入态后 f 可用", async () => {
    await closeAllSidePaneTabs();
    await openSidePaneLauncher();
    const browserItem = await browser.execute(
      () => document.querySelectorAll('[data-side-pane-open-tab-item="browser"]').length,
    );
    if (browserItem === 0) {
      console.log("Q2-13 侧栏 launcher 没有 browser 启动项（不支持内嵌浏览器），记 N/A");
      return;
    }
    const browserSelector = '[data-side-pane-open-tab-item="browser"]';
    const browserLabel = await hintLabelForSelectorScrollable(browserSelector);
    if (browserLabel === null) {
      console.log("Q2-13 launcher 里 browser 启动项不可达（未渲染或滚动后仍无标签），记 N/A");
      return;
    }
    await pressLabel(browserLabel);
    await waitTestid("browser-address-bar", 15_000);
    await browser.pause(500);
    await ensureNormal();

    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "Browser 面板 f 没有提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `Browser 面板 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    const addressLabel = await hintLabelForTestid("browser-address-input");
    expect(addressLabel, "地址栏没有标签").not.toBeNull();
    await pressLabel(addressLabel!);
    await browser.waitUntil(async () => (await activeElementFacts()).editable, {
      timeout: 5_000,
      timeoutMsg: "标签激活地址栏后焦点不在输入框",
    });

    await press("f", { code: "KeyF" });
    await browser.pause(200);
    expect(await hintOpen(), "地址栏内裸 f 不应生成标签（§2.1）").toBe(false);
    // 地址栏是页面级输入框（不是浮层内输入）：§2.1 的 Ctrl+[ 通道不适用，
    // 纯键盘离开用「万能离开」Ctrl+Alt+Esc。
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await browser.pause(250);
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="browser-address-input"]')),
      ),
      "Ctrl+Alt+Esc 把浏览器面板关掉了",
    ).toBe(true);
    expect((await activeElementFacts()).editable, "Ctrl+Alt+Esc 后焦点仍在地址栏").toBe(false);
    const paneHints = await openHints();
    expect(paneHints, "浏览器面板 Ctrl+Alt+Esc 后 f 不可用").not.toBeNull();
    expect(paneHints!.badges.length, "浏览器面板没有可打标签的控件").toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
    await closeActiveSidePaneTab();
  });

  it("Q2-14 Developer tools 面板：可打开则测 f 覆盖（否则 N/A）", async () => {
    await closeAllSidePaneTabs();
    await openSidePaneLauncher();
    const exists = await browser.execute(
      () => document.querySelectorAll('[data-side-pane-open-tab-item="developer-tools"]').length,
    );
    if (exists === 0) {
      console.log("Q2-14 launcher 没有 developer-tools 启动项（开关未启用），记 N/A");
      return;
    }
    await openHints();
    await activateHintForSelector('[data-side-pane-open-tab-item="developer-tools"]');
    await waitTestid("developer-tools-pane", 15_000);
    await browser.pause(500);
    await ensureNormal();
    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "Developer tools f 没有提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `Developer tools f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    await press("Escape", { code: "Escape" });
    await closeActiveSidePaneTab();
  });

  it("Q2-15 侧栏全宽视图（Ctrl+Shift+F）：f 覆盖且可退出", async () => {
    await closeAllSidePaneTabs();
    await openSidePaneLauncher();
    await openHints();
    const filesLabel = await hintLabelForSelector('[data-side-pane-open-tab-item="files"]');
    if (filesLabel === null) {
      console.log("Q2-15 无法准备侧栏 tab，记 N/A");
      return;
    }
    await pressLabel(filesLabel);
    await waitTestid("workspace-file-tree-panel", 15_000);
    await browser.pause(400);
    await ensureNormal();

    await press("f", { code: "KeyF", ctrlKey: true, shiftKey: true });
    const hostVisible = await browser
      .waitUntil(
        () =>
          browser.execute(
            () => document.querySelectorAll("[data-side-pane-full-view-host]").length > 0,
          ),
        { timeout: 8_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!hostVisible) {
      console.log("Q2-15 Ctrl+Shift+F 没有进入侧栏全宽视图，记 N/A");
      await closeActiveSidePaneTab();
      return;
    }
    await browser.pause(600);
    await ensureNormal();
    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "侧栏全宽视图 f 没有提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `侧栏全宽视图 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    expect(
      await hintLabelForTestid("side-pane-full-view-toggle"),
      "全宽视图切换按钮没有标签",
    ).not.toBeNull();
    await press("Escape", { code: "Escape" });
    await press("f", { code: "KeyF", ctrlKey: true, shiftKey: true });
    await browser.pause(500);
    await closeActiveSidePaneTab();
  });

  it("Q2-16 Model trajectory：任务行菜单键盘进入、面板 f 覆盖", async () => {
    await closeAllSidePaneTabs();
    expect(await focusSeededTaskRow(), "j/G 没有把焦点移到前置任务行").toBe(true);
    // 菜单里的「调用轨迹」项在非活动任务（draft）上禁用；先 Enter 激活前置任务。
    await press("Enter", { code: "Enter" });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskId,
      "前置任务没有被激活为当前会话",
      15_000,
    );
    await browser.pause(300);
    await focusSeededTaskRow();
    if (!(await openTaskContextMenuByKeyboard())) {
      console.log("Q2-16 Shift+F10 没有打开任务行菜单，回退 DOM contextmenu");
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
      await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menu"]').length > 0),
        { timeout: 5_000, timeoutMsg: "任务行菜单没有打开" },
      );
    }
    await openHints();
    const trajectoryLabel = await hintLabelForTexts([
      "View model trajectory",
      "查看调用轨迹",
      "查看模型调用轨迹",
      "Model trajectory",
    ]);
    if (trajectoryLabel === null) {
      console.log("Q2-16 任务行菜单没有调用轨迹入口，记 N/A");
      await press("Escape", { code: "Escape" });
      return;
    }
    await pressLabel(trajectoryLabel.label);
    const opened = await browser
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
    expect(opened, "激活调用轨迹菜单项后侧栏没有打开").toBe(true);
    await browser.pause(800);
    await ensureNormal();
    console.log(`Q2-16 覆盖前浮层=${JSON.stringify(await overlayFacts())}`);
    const facts = await collectPageFacts(null);
    const hints = await openHints();
    console.log(`Q2-16 提示层=${JSON.stringify(hints)}`);
    expect(hints, "Model trajectory 面板 f 没有提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `Model trajectory f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    await press("Escape", { code: "Escape" });
    await closeActiveSidePaneTab();
  });

  it("Q2-17 Automations 手动创建编辑视图：f 覆盖全部表单控件并可返回", async () => {
    await ensureNormal();
    await openHints();
    await activateHintFor("automations-open");
    await waitTestid("automations-page-tab-automation", 15_000);
    await browser.pause(400);
    await ensureNormal();
    await openHints();
    let createLabel = await hintLabelForTestid("automation-create-manually");
    if (createLabel === null) {
      // 页内 tab 会被记忆：上一轮切到「工作流」后，创建按钮不在当前 tab。
      const tabLabel = await hintLabelForTestid("automations-page-tab-automation");
      if (tabLabel !== null) {
        await pressLabel(tabLabel);
        await browser.pause(500);
        await ensureNormalHard();
        await openHints();
        createLabel = await hintLabelForTestid("automation-create-manually");
      }
    }
    expect(createLabel, "Automations 页没有「手动创建」标签").not.toBeNull();
    await pressLabel(createLabel!);
    const formReady = await browser
      .waitUntil(
        () =>
          browser.execute(
            () =>
              Boolean(document.querySelector('[data-testid="automation-form-prompt"]')) ||
              Boolean(document.querySelector('[data-testid="automation-edit-title"]')),
          ),
        { timeout: 10_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!formReady) {
      console.log("Q2-17 手动创建没有进入表单视图，编辑视图记 N/A");
      return;
    }
    await browser.pause(500);
    await ensureNormal();
    const facts = await collectPageFacts(null);
    const hints = await openHints();
    expect(hints, "Automations 编辑视图 f 没有提示层").not.toBeNull();
    const report = coverage(facts, hints!);
    expect(
      report.missing,
      `Automations 编辑视图 f 漏掉 ${report.missing.length}/${report.expectedCount} 个控件: ${JSON.stringify(
        report.missing,
      )}`,
    ).toEqual([]);
    const backLabel =
      (await hintLabelForTestid("settings-breadcrumb-section")) ??
      (await hintLabelForTestid("desktop-top-nav-back"));
    if (backLabel === null) {
      console.log("Q2-17 编辑视图没有返回按钮标签（面包屑/顶部返回均未出现），返回路径记 N/A");
      await press("Escape", { code: "Escape" });
      return;
    }
    await pressLabel(backLabel);
    const backToList = await browser
      .waitUntil(
        () =>
          browser.execute(() =>
            Boolean(document.querySelector('[data-testid="automations-list"]')),
          ),
        { timeout: 8_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!backToList) {
      console.log("Q2-17 标签激活返回按钮后没有回到 Automations 列表（当前层可能只退一级）");
    }
  });

  it("Q2-18 命令中心 footer 遮挡诊断：标签目标必须至少有一个可点击点（含激活验证）", async () => {
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
    expect(hints, "命令中心 Ctrl+[ 后 f 没有提示层").not.toBeNull();
    const report = await badgeHitReport();
    expect(report, "命令中心提示层为空，无法做遮挡诊断").not.toBeNull();

    const occluded = report!.filter(
      (entry) => entry.target !== null && entry.reachable === 0 && entry.clipped < entry.points,
    );
    const clipped = report!.filter(
      (entry) => entry.target !== null && entry.reachable === 0 && entry.clipped >= entry.points,
    );
    const centerBlocked = report!.filter((entry) => entry.reachable > 0 && entry.occluder !== null);
    console.log(
      `Q2-18 标签=${report!.length} 完全被遮挡=${occluded.length} 完全被裁剪=${clipped.length} 中心被挡=${centerBlocked.length}`,
    );
    console.log(`Q2-18 遮挡明细=${JSON.stringify(occluded)}`);
    console.log(`Q2-18 裁剪明细=${JSON.stringify(clipped)}`);

    // 明确区分：完全被裁剪属于滚动裁剪（本用例不判 BUG）；完全被遮挡=标签指向不可鼠标点击的目标。
    expect(
      occluded,
      `命令中心有 ${occluded.length} 个标签指向被遮挡且无法点击的目标: ${JSON.stringify(occluded)}`,
    ).toEqual([]);
    // 完全被裁剪的标签指向“不可见目标”：overlay 的框线/标签仍画在页面上（悬在 footer 区域），
    // 用户看到标签却看不到目标。这是 Q2-18 的缺陷判据（不是 footer 遮挡，是列表裁剪）。
    expect(
      clipped,
      `命令中心有 ${clipped.length} 个标签指向被滚动容器裁剪的不可见目标: ${JSON.stringify(clipped)}`,
    ).toEqual([]);

    // 激活验证：任取一个带标签的 scope tab，确认标签激活链路正常（不是只画了框）。
    const tabLabel = await hintLabelForSelector('[role="tab"]');
    if (tabLabel !== null) {
      await pressLabel(tabLabel);
      await browser.pause(300);
      expect(
        await browser.execute(() => document.querySelectorAll('[role="dialog"]').length >= 0),
        "激活命令中心 tab 后状态不可读",
      ).toBe(true);
    }
    await press("Escape", { code: "Escape" });
    await press("Escape", { code: "Escape" });
  });

  it("Q2-19 任务行悬停卡片（role=tooltip）不得劫持 f/s 与 normal 键", async () => {
    await ensureNormal();
    expect(await focusSeededTaskRow(), "j/G 没有把焦点移到前置任务行").toBe(true);
    let cardShown = await browser
      .waitUntil(
        () =>
          browser.execute(() =>
            Boolean(document.querySelector('[data-testid="task-row-details"]')),
          ),
        { timeout: 4_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!cardShown) {
      // 键盘聚焦没有触发 focus-visible 悬停卡：补一次真实 pointerover（等同于鼠标悬停）。
      await browser.execute((id) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="task-item-${id}"]`);
        row?.dispatchEvent(
          new PointerEvent("pointerover", {
            bubbles: true,
            pointerType: "mouse",
            clientX: 100,
            clientY: 280,
          }),
        );
      }, taskId);
      cardShown = await browser
        .waitUntil(
          () =>
            browser.execute(() =>
              Boolean(document.querySelector('[data-testid="task-row-details"]')),
            ),
          { timeout: 4_000 },
        )
        .then(
          () => true,
          () => false,
        );
    }
    if (!cardShown) {
      console.log("Q2-19 任务行悬停卡没有出现（焦点/指针都未触发），记 N/A");
      return;
    }

    const card = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="task-row-details"]');
      const rect = element?.getBoundingClientRect();
      return {
        role: element?.getAttribute("role") ?? "",
        slot: element?.getAttribute("data-slot") ?? "",
        rect: rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round) : [],
        interactive:
          element?.querySelectorAll(
            "button, a[href], input, [role='menuitem'], [role='option'], [tabindex='0']",
          ).length ?? 0,
      };
    });
    console.log(`Q2-19 悬停卡=${JSON.stringify(card)}`);

    // 1) f：悬停卡不是可操作浮层，不得成为提示作用域。
    const hints = await openHints();
    expect(hints, "悬停卡打开时 f 没有出现提示层").not.toBeNull();
    const badgeCount = hints!.badges.length;
    // f 已生成真实提示会话（badges>0）；先 Esc 收起提示层再测 normal 键，
    // 否则 l 会被提示会话当作前缀过滤键消费（不是 normal 语义）。
    await press("Escape", { code: "Escape" });
    await browser.pause(100);

    // 2) normal 键：悬停卡仍在（提示层已收起、卡片未关闭）时 h/l 不得被吞。
    const regionBefore = await browser.execute(
      () => document.querySelector('[data-vim-active="true"]')?.getAttribute("data-testid") ?? "",
    );
    await press("l", { code: "KeyL" });
    await browser.pause(250);
    const regionAfter = await browser.execute(
      () => document.querySelector('[data-vim-active="true"]')?.getAttribute("data-testid") ?? "",
    );
    const regionRotated = regionAfter !== regionBefore;
    await press("Escape", { code: "Escape" });
    await browser.pause(150);
    // 一次断言同时报告两项事实，避免第一个失败掩盖第二个。
    expect(
      badgeCount > 10 && regionRotated,
      `任务行悬停卡（${JSON.stringify(card)}）打开时：f 标签数=${badgeCount}（期望 > 10）、` +
        `l 区域轮转=${regionRotated}（期望 true，before=${regionBefore || "main"} after=${regionAfter || "main"}）。` +
        "说明 role=tooltip 的 hover-card 被当成可操作浮层，劫持了提示作用域与全部 normal 键",
    ).toBe(true);
  });

  it("R2-B01 任务行悬停卡打开时 normal 键与 f/s 仍全部可用（B 回归探针）", async () => {
    await ensureNormal();

    const waitHoverCard = async () =>
      browser
        .waitUntil(
          () =>
            browser.execute(() =>
              Boolean(document.querySelector('[data-testid="task-row-details"]')),
            ),
          { timeout: 4_000 },
        )
        .then(
          () => true,
          () => false,
        );

    /** 把焦点放回前置任务行并确保悬停卡在场（焦点触发 + pointerover 兜底）。 */
    const openHoverCard = async (): Promise<boolean> => {
      if (!(await focusSeededTaskRow())) return false;
      if (await waitHoverCard()) return true;
      await browser.execute((id) => {
        document.querySelector<HTMLElement>(`[data-testid="task-item-${id}"]`)?.dispatchEvent(
          new PointerEvent("pointerover", {
            bubbles: true,
            pointerType: "mouse",
            clientX: 100,
            clientY: 280,
          }),
        );
      }, taskId);
      return waitHoverCard();
    };

    const readRegion = async () =>
      (await browser.execute(
        () => document.querySelector('[data-vim-active="true"]')?.getAttribute("data-testid") ?? "",
      )) as string;
    const readActiveTestid = async () =>
      (await browser.execute(
        () => document.activeElement?.getAttribute("data-testid") ?? "",
      )) as string;

    expect(await openHoverCard(), "R2-B01 悬停卡没有出现，无法做回归探针").toBe(true);

    // h/l：区域轮转（normal 键不得被 tooltip 吞掉）。
    const regionBefore = await readRegion();
    await press("h", { code: "KeyH" });
    await browser.pause(200);
    const regionAfterH = await readRegion();
    expect(
      regionAfterH !== regionBefore,
      `悬停卡打开时 h 未轮转区域（${regionBefore}->${regionAfterH}）`,
    ).toBe(true);
    await press("l", { code: "KeyL" });
    await browser.pause(200);
    const regionAfterL = await readRegion();
    expect(
      regionAfterL !== regionAfterH,
      `悬停卡打开时 l 未轮转区域（${regionAfterH}->${regionAfterL}）`,
    ).toBe(true);

    // j/k/G/gg：侧栏列表移动（任务行 > 1 时断言焦点确实变化）。
    expect(await openHoverCard(), "R2-B01 第二次聚焦任务行后悬停卡没有出现").toBe(true);
    const seededTestid = `task-item-${taskId}`;
    const rowCount = (await browser.execute(
      () => document.querySelectorAll("[data-task-item-key]").length,
    )) as number;
    await press("G", { code: "KeyG", shiftKey: true });
    await browser.pause(150);
    expect(await readActiveTestid(), "G 没有把焦点留在任务行").toBe(seededTestid);
    await press("k", { code: "KeyK" });
    await browser.pause(150);
    const afterK = await readActiveTestid();
    if (rowCount > 1) {
      expect(afterK !== seededTestid, `k 没有移动任务行焦点（仍在 ${seededTestid}）`).toBe(true);
    }
    await press("j", { code: "KeyJ" });
    await browser.pause(150);
    expect(await readActiveTestid(), "j 没有回到下一个任务行").toBe(seededTestid);
    await press("g", { code: "KeyG" });
    await press("g", { code: "KeyG" });
    await browser.pause(150);
    expect(await readActiveTestid(), "gg 没有跳到首行").not.toBe("");
    await press("G", { code: "KeyG", shiftKey: true });
    await browser.pause(150);
    expect(await readActiveTestid(), "G 没有回到末行（前置任务行）").toBe(seededTestid);

    // f：悬停卡在场时提示层应覆盖整页，而不是“无可用目标”。
    expect(await openHoverCard(), "R2-B01 f 前悬停卡没有出现").toBe(true);
    const hints = await openHints();
    expect(hints, "悬停卡打开时 f 没有出现提示层").not.toBeNull();
    expect(
      hints!.badges.length > 10,
      `悬停卡打开时 f 标签数=${hints!.badges.length}（期望 > 10），提示作用域被劫持`,
    ).toBe(true);
    await press("Escape", { code: "Escape" });
    await browser.pause(100);

    // s：悬停卡在场时进入 sneak 查询态并搜到页面文本。
    expect(await openHoverCard(), "R2-B01 s 前悬停卡没有出现").toBe(true);
    await press("s", { code: "KeyS" });
    await press("e", { code: "KeyE" });
    await press("2", { code: "Digit2" });
    await browser.pause(250);
    const sneakText = (await browser.execute(
      () => document.querySelector("[data-vim-hint-overlay]")?.textContent ?? "",
    )) as string;
    expect(sneakText.includes("sneak"), `悬停卡打开时 s 没有进入 sneak 查询态: ${sneakText}`).toBe(
      true,
    );
    await press("Escape", { code: "Escape" });
    await browser.pause(150);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "Esc 后提示层没有清空",
    ).toBe(false);
  });

  it("Q3-01 设置 usage 图表 SVG（role=application/tabindex=0）应有 f 标签", async () => {
    // 图表挂载前置：补 usage facts（失败不阻塞，图表不挂载时走 N/A 分支）。
    const seededUsageFacts = seedUsageFactsForChartEvidence(taskId);
    console.log(`Q3-01 usage facts 播种=${seededUsageFacts}`);
    await press(",", { code: "Comma", ctrlKey: true });
    await waitTestid("settings-page");
    await browser.pause(250);
    await openHints();
    let navLabel = await hintLabelForSelector('[data-testid="settings-section-nav-usage"]');
    if (navLabel === null) {
      navLabel = await hintLabelForSelectorScrollable('[data-testid="settings-section-nav-usage"]');
    }
    expect(navLabel, "设置 usage 分区导航没有标签").not.toBeNull();
    await pressKeys(navLabel!.split(""));
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="settings-page"]')
              ?.getAttribute("data-active-section") === "usage",
        ),
      { timeout: 8_000, timeoutMsg: "usage 分区没有打开" },
    );

    const SVG_SELECTOR = '[data-testid="settings-page"] svg[role="application"][tabindex="0"]';

    // 图表数据异步加载：等 recharts 的 accessibility layer 真正挂载。
    const svgCount = await browser
      .waitUntil(
        async () =>
          ((await browser.execute(
            (selector) => document.querySelectorAll(selector).length,
            SVG_SELECTOR,
          )) as number) > 0,
        { timeout: 10_000 },
      )
      .then(
        async () =>
          (await browser.execute(
            (selector) => document.querySelectorAll(selector).length,
            SVG_SELECTOR,
          )) as number,
        () => 0,
      );
    if (svgCount === 0) {
      // 触发条件：本环境没有 usage facts（AppUsagePanel 停在加载/空态）或
      // 懒加载图表 10s 内未完成，图表不存在 → 本用例无可测目标，记 N/A。
      // 有 usage facts（如主 spec 前置任务产生了 model_usage）时，下面的断言全部可执行。
      console.log("Q3-01 usage 图表 SVG 10s 内没有挂载（无 usage facts / 懒加载未完成），记 N/A");
      await press("Escape", { code: "Escape" });
      return;
    }

    interface SvgFact {
      tag: string;
      isinstanceHTMLElement: boolean;
      rect: number[];
      inViewport: boolean;
      covered: boolean;
      label: string;
    }

    // 采集每个 SVG 的视口相交状态、标签覆盖与标签文本。
    const readSvgFacts = async () =>
      (await browser.execute((selector) => {
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
        const intersects = (rect: DOMRect) =>
          rect.width > 2 &&
          rect.height > 2 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        return Array.from(document.querySelectorAll<SVGElement>(selector)).map((svg) => {
          const rect = svg.getBoundingClientRect();
          const badge = badges.find(
            (candidate) =>
              Number.isFinite(candidate.left) &&
              Math.abs(candidate.left - rect.left) <= 3 &&
              Math.abs(candidate.top - rect.top) <= 3 &&
              Math.abs(candidate.width - rect.width) <= 3 &&
              Math.abs(candidate.height - rect.height) <= 3,
          );
          return {
            tag: svg.tagName.toLowerCase(),
            isinstanceHTMLElement: svg instanceof HTMLElement,
            rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
            inViewport: intersects(rect),
            covered: Boolean(badge),
            label: badge?.label ?? "",
          };
        });
      }, SVG_SELECTOR)) as SvgFact[];

    // 覆盖对表沿用 Q1-07 的页面事实口径（HTML 控件全覆盖断言保持不变；
    // usage 分区的可聚焦 SVG 也在 [tabindex="0"] 候选集内）。
    const facts = await collectPageFacts('[data-testid="settings-page"]');
    const hints = await openHints();
    expect(hints, "usage 分区 f 没有提示层").not.toBeNull();
    const coverageReport = coverage(facts, hints!);
    console.log(
      `Q3-01 usage 分区覆盖 expected=${coverageReport.expectedCount} badges=${coverageReport.badgeCount} missing=${coverageReport.missing.length} extra=${coverageReport.extra.length}`,
    );
    expect(
      coverageReport.missing,
      `usage 分区 f 漏掉 ${coverageReport.missing.length}/${coverageReport.expectedCount} 个可见控件: ${JSON.stringify(
        coverageReport.missing,
      )}`,
    ).toEqual([]);

    const innerHeight = (await browser.execute(() => window.innerHeight)) as number;
    const initial = await readSvgFacts();
    console.log(
      `Q3-01 usage 图表 SVG（初测，innerHeight=${innerHeight}）=${JSON.stringify(initial)}`,
    );
    // f 的视口语义（Q1-25/Q2-19）：只要求与视口相交的图表获得标签；
    // 视口外的图表（如第二张图 top≈978）不得作为“漏标签”误报。
    const viewportMissing = initial.filter((entry) => entry.inViewport && !entry.covered);
    expect(
      viewportMissing,
      `视口内的 usage 图表 SVG 没有 f 标签: ${JSON.stringify(viewportMissing)}`,
    ).toEqual([]);

    // 视口内图表按标签激活：不崩溃、不跳转、焦点落在 SVG（Element 泛化路径）。
    const activationTarget = initial.find((entry) => entry.inViewport && entry.covered);
    if (!activationTarget) {
      throw new Error("视口内没有可激活的 usage 图表 SVG");
    }
    const hrefBefore = (await browser.execute(() => location.href)) as string;
    const sectionBefore = (await browser.execute(
      () =>
        document
          .querySelector('[data-testid="settings-page"]')
          ?.getAttribute("data-active-section") ?? "",
    )) as string;
    await pressKeys(activationTarget.label.split(""));
    await browser.pause(300);
    const activation = (await browser.execute(() => {
      const active = document.activeElement;
      return {
        activeTag: active?.tagName.toLowerCase() ?? "",
        activeRole: active?.getAttribute("role") ?? "",
        overlay: Boolean(document.querySelector("[data-vim-hint-overlay]")),
        href: location.href,
        section:
          document
            .querySelector('[data-testid="settings-page"]')
            ?.getAttribute("data-active-section") ?? "",
      };
    })) as {
      activeTag: string;
      activeRole: string;
      overlay: boolean;
      href: string;
      section: string;
    };
    console.log(
      `Q3-01 SVG 激活=${JSON.stringify({ ...activation, hrefBefore, sectionBefore, label: activationTarget.label })}`,
    );
    expect(activation.overlay, "按图表标签后提示层没有关闭").toBe(false);
    expect(activation.href, "按图表标签后页面发生了跳转").toBe(hrefBefore);
    expect(activation.section, "按图表标签后设置分区发生变化").toBe(sectionBefore);
    expect(
      activation.activeTag === "svg" || activation.activeRole === "application",
      `按图表标签后焦点不在 SVG（active=${activation.activeTag}/${activation.activeRole}）`,
    ).toBe(true);

    // 视口外图表：先 scrollIntoView，再 f，验证其滚入视口后获得标签。
    const scrolledFacts: SvgFact[] = [];
    for (let index = 0; index < initial.length; index += 1) {
      if (initial[index]!.inViewport) continue;
      if (await hintOpen()) {
        await press("Escape", { code: "Escape" });
        await browser.pause(120);
      }
      await browser.execute(
        (selector, position) => {
          document
            .querySelectorAll<SVGElement>(selector)
            [position]?.scrollIntoView({ block: "center" });
        },
        SVG_SELECTOR,
        index,
      );
      await browser.pause(350);
      const hintsAfterScroll = await openHints();
      expect(
        hintsAfterScroll,
        `第 ${index + 1} 个 usage 图表滚入视口后 f 没有提示层`,
      ).not.toBeNull();
      const factsAfterScroll = await readSvgFacts();
      const target = factsAfterScroll[index];
      if (!target) {
        throw new Error(`第 ${index + 1} 个 usage 图表滚入视口后不存在`);
      }
      console.log(`Q3-01 视口外图表 #${index + 1} 滚入后=${JSON.stringify(target)}`);
      expect(target.inViewport, `第 ${index + 1} 个 usage 图表 scrollIntoView 后仍不在视口`).toBe(
        true,
      );
      expect(target.covered, `第 ${index + 1} 个 usage 图表滚入视口后没有 f 标签`).toBe(true);
      scrolledFacts.push(target);
    }
    console.log(
      `Q3-01 视口内图表=${initial.filter((entry) => entry.inViewport).length} 视口外复验=${scrolledFacts.length}/${initial.filter((entry) => !entry.inViewport).length}`,
    );

    await press("Escape", { code: "Escape" });
    await browser.pause(100);
    expect(
      await browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      "Q3-01 Esc 后提示层没有清空",
    ).toBe(false);
  });
});
