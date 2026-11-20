import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const INDICATOR = '[data-testid="vim-mode-indicator"]';
const HELP = '[data-testid="vim-help"]';
const HINT_OVERLAY = "[data-vim-hint-overlay]";

interface KeyOptions {
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/**
 * 合成 keydown 发到当前焦点元素并冒泡：vim 层与快捷键内核挂在 window capture，
 * 对话框/输入框的 React 处理器挂在元素上；只发 window 会漏掉后者（Esc 关不掉
 * 命令中心）。事件字段齐全，锁屏/CI 无窗口焦点时仍能覆盖完整键盘路径。
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

async function indicatorText() {
  return (await browser.execute(
    () => document.querySelector('[data-testid="vim-mode-indicator"]')?.textContent ?? "",
  )) as string;
}

async function ensureVimEnabled() {
  if (await $(INDICATOR).isExisting()) return;
  await press("v", { code: "KeyV", ctrlKey: true, altKey: true });
  await $(INDICATOR).waitForDisplayed({ timeout: 10_000, timeoutMsg: "快捷键没有打开 Vim 导航" });
}

/** 准备阶段会聚焦草稿输入框，开启后先退出 INSERT，后续从确定状态开始。 */
async function ensureNormal() {
  if ((await indicatorText()).includes("INSERT")) {
    await press("[", { code: "BracketLeft", ctrlKey: true });
  }
  await waitMode("NORMAL");
}

async function waitMode(mode: "NORMAL" | "INSERT") {
  await browser.waitUntil(async () => (await indicatorText()).includes(mode), {
    timeout: 10_000,
    timeoutMsg: `Vim 徽标没有进入 ${mode}`,
  });
}

async function regionActive(id: "sidebar" | "main") {
  return (await browser.execute((regionId) => {
    const selector = regionId === "sidebar" ? '[data-testid="sidebar"]' : "main";
    return document.querySelector(`${selector}[data-vim-active="true"]`) !== null;
  }, id)) as boolean;
}

async function ensureRegion(id: "sidebar" | "main") {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await regionActive(id)) return;
    // 只有两个区域时 h/l 都会把焦点切到另一侧，按一次再判断即可。
    await press("l", { code: "KeyL" });
    await browser.pause(150);
  }
  expect(await regionActive(id)).toBe(true);
}

describe("Vim 键盘导航", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  after(async () => {
    // Vim 是全局键盘层，残留开启会影响同 worker 的后续用例；结束前关掉。
    if (await $(INDICATOR).isExisting()) {
      await press("v", { code: "KeyV", ctrlKey: true, altKey: true });
      await $(INDICATOR).waitForDisplayed({ reverse: true });
    }
    await clearAppData();
  });

  it("VIM-01：快捷键开启、NORMAL/INSERT 徽标与帮助浮层键盘关闭", async () => {
    await ensureVimEnabled();
    await ensureNormal();

    // ? 打开帮助；帮助文案承诺「按 ? 或 Esc 关闭」，两条路径都必须生效。
    await press("?", { code: "Slash", shiftKey: true });
    await $(HELP).waitForDisplayed({ timeout: 5_000 });
    await press("Escape", { code: "Escape" });
    await $(HELP).waitForDisplayed({ reverse: true });
    await press("?", { code: "Slash", shiftKey: true });
    await $(HELP).waitForDisplayed({ timeout: 5_000 });
    await press("?", { code: "Slash", shiftKey: true });
    await $(HELP).waitForDisplayed({ reverse: true });

    // i 进入聊天输入框 = INSERT；Ctrl+[ 回到普通模式。
    await press("i", { code: "KeyI" });
    await waitMode("INSERT");
    expect(
      await browser.execute(
        () => document.activeElement?.getAttribute("data-testid") === "v4-composer-input",
      ),
    ).toBe(true);
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await waitMode("NORMAL");
  });

  it("VIM-02：h/l 区域轮转与 j/k 列表焦点移动", async () => {
    await ensureVimEnabled();
    await ensureNormal();
    await ensureRegion("sidebar");
    await press("j", { code: "KeyJ" });
    const sidebarFocus = await browser.execute(() => {
      const active = document.activeElement as HTMLElement | null;
      return {
        inSidebar: Boolean(active?.closest('[data-testid="sidebar"]')),
        isNavItem: Boolean(
          active?.closest(
            '[data-task-item-key], [data-testid^="task-item-"], [data-testid="virtual-project-row"]',
          ),
        ),
      };
    });
    expect(sidebarFocus).toEqual({ inSidebar: true, isNavItem: true });

    await press("l", { code: "KeyL" });
    await browser.waitUntil(() => regionActive("main"), {
      timeout: 5_000,
      timeoutMsg: "l 没有把活动区域切到主区",
    });
    expect(
      await browser.execute(
        () => document.activeElement?.closest('[data-v4-timeline-scroll="true"]') !== null,
      ),
    ).toBe(true);
  });

  it("VIM-03：f 提示标签与 s 双字符文本跳转", async () => {
    await ensureVimEnabled();
    await ensureNormal();
    await ensureRegion("sidebar");

    await press("f", { code: "KeyF" });
    await $(HINT_OVERLAY).waitForDisplayed({ timeout: 5_000 });
    const hintCount = await browser.execute(
      () => document.querySelectorAll("[data-vim-hint-overlay] span").length,
    );
    expect(hintCount).toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });

    // 侧栏项目行文案包含 ZCodeProject，用 zc 命中并展示 sneak 浮层。
    await press("s", { code: "KeyS" });
    await press("z", { code: "KeyZ" });
    await press("c", { code: "KeyC" });
    await $(HINT_OVERLAY).waitForDisplayed({ timeout: 5_000 });
    expect(await $(HINT_OVERLAY).getText()).toContain("sneak zc");
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });
  });

  it("VIM-04：j/G/gg 滚动与冒号命令中心", async () => {
    await ensureVimEnabled();
    await ensureNormal();
    await ensureRegion("main");

    // 空草稿时间线没有可滚动高度；只注入高度占位，滚动容器与 vim 层保持真实。
    await browser.execute(() => {
      const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')!;
      const filler = document.createElement("div");
      filler.id = "vim-scroll-filler";
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

    await press("j", { code: "KeyJ" });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')?.scrollTop ??
              0) > 0,
        ),
      { timeout: 5_000, timeoutMsg: "j 没有向下滚动主区" },
    );

    await press("G", { code: "KeyG", shiftKey: true });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')!;
          return timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 4;
        }),
      { timeout: 5_000, timeoutMsg: "G 没有滚到底部" },
    );

    await press("g", { code: "KeyG" });
    await press("g", { code: "KeyG" });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')?.scrollTop ??
              0) === 0,
        ),
      { timeout: 5_000, timeoutMsg: "gg 没有滚回顶部" },
    );
    await browser.execute(() => document.querySelector("#vim-scroll-filler")?.remove());

    // : 打开命令中心（冒号在 US 布局上需要 Shift）。
    await press(":", { code: "Semicolon", shiftKey: true });
    await $('[role="dialog"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: ": 没有打开命令中心",
    });
    await press("Escape", { code: "Escape" });
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
  });

  it("VIM-05：设置页外观开关与常驻徽标联动", async () => {
    // 从确定的关闭态开始；若上一用例遗留开启则先用快捷键关掉。
    if (await $(INDICATOR).isExisting()) {
      await press("v", { code: "KeyV", ctrlKey: true, altKey: true });
      await $(INDICATOR).waitForDisplayed({ reverse: true });
    }

    const openAppearance = async () => {
      const nav = $('[data-testid="settings-section-nav-appearance"]');
      await nav.waitForDisplayed({ timeout: 10_000 });
      await nav.click();
      const toggle = $('[data-testid="settings-vim-navigation-switch"]');
      await toggle.waitForDisplayed({ timeout: 10_000 });
      return toggle;
    };
    const waitChecked = (toggle: ReturnType<typeof $>, checked: boolean) =>
      browser.waitUntil(
        async () => (await toggle.getAttribute("aria-checked")) === String(checked),
        { timeout: 5_000, timeoutMsg: `设置开关没有变为 ${checked ? "开启" : "关闭"}` },
      );

    // 设置页路由会隐藏工作区（含右下角徽标），因此先在设置页断言开关，
    // 返回工作区后再断言徽标显隐——与用户实际路径一致。
    await $('[data-testid="task-settings-button"]').click();
    let toggle = await openAppearance();
    await toggle.click();
    await waitChecked(toggle, true);
    await $('[data-testid="settings-back-button"]').click();
    await $(INDICATOR).waitForDisplayed({ timeout: 5_000 });
    expect(await indicatorText()).toContain("NORMAL");

    await $('[data-testid="task-settings-button"]').click();
    toggle = await openAppearance();
    await toggle.click();
    await waitChecked(toggle, false);
    await $('[data-testid="settings-back-button"]').click();
    await $(INDICATOR).waitForDisplayed({ reverse: true });
  });

  it("VIM-06：设置页里 f 继续导航、s 双字符搜索可用，标签不压住目标", async () => {
    await ensureVimEnabled();
    await ensureNormal();

    await $('[data-testid="task-settings-button"]').click();
    const settingsPage = $('[data-testid="settings-page"]');
    await settingsPage.waitForDisplayed({ timeout: 10_000 });

    // 设置页覆盖 workspace 时，workspace 整棵子树是 opacity-0 + inert。
    // 提示层必须挂在该子树之外并且真实可见，否则 f 看起来完全没反应。
    await press("f", { code: "KeyF" });
    await $(HINT_OVERLAY).waitForDisplayed({ timeout: 5_000 });
    const hintState = await browser.execute(() => {
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      if (!overlay) return null;
      let node: HTMLElement | null = overlay;
      let effectiveOpacity = 1;
      let insideInert = false;
      while (node) {
        effectiveOpacity *= Number.parseFloat(getComputedStyle(node).opacity || "1");
        if (node.hasAttribute("inert")) insideInert = true;
        node = node.parentElement;
      }
      const rect = overlay.getBoundingClientRect();
      return {
        effectiveOpacity,
        insideInert,
        width: Math.round(rect.width),
        badgeCount: overlay.querySelectorAll("span").length,
      };
    });
    expect(hintState).not.toBeNull();
    expect(hintState!.insideInert).toBe(false);
    expect(hintState!.effectiveOpacity).toBe(1);
    expect(hintState!.width).toBeGreaterThan(200);
    expect(hintState!.badgeCount).toBeGreaterThan(0);

    // 标签必须在目标元素框外：找到「外观」导航按钮对应的标签，断言它整体位于元素
    // 上方或下方（旧实现居中压在按钮上，把文字挡住了）。
    const appearance = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-testid="settings-section-nav-appearance"]',
      );
      const overlay = document.querySelector<HTMLElement>("[data-vim-hint-overlay]");
      if (!element || !overlay) return null;
      const rect = element.getBoundingClientRect();
      // 同一列里可能有多行导航按钮，取距离最近的标签（1px 间隙）；远处的同列标签不算。
      const nearest = Array.from(overlay.querySelectorAll("span"))
        .map((span) => {
          const box = span.getBoundingClientRect();
          const above = box.bottom <= rect.top + 0.5;
          const below = box.top >= rect.bottom - 0.5;
          const distance = above
            ? rect.top - box.bottom
            : below
              ? box.top - rect.bottom
              : Number.POSITIVE_INFINITY;
          return {
            label: span.textContent ?? "",
            sameColumn: Math.abs(box.left - rect.left) <= 6,
            distance,
            insideElement:
              box.bottom > rect.top &&
              box.top < rect.bottom &&
              box.right > rect.left &&
              box.left < rect.right,
          };
        })
        .filter((candidate) => candidate.sameColumn && Number.isFinite(candidate.distance))
        .sort((a, b) => a.distance - b.distance);
      const best = nearest[0];
      return {
        label: best?.label ?? "",
        distance: best?.distance ?? Number.POSITIVE_INFINITY,
        inside: best?.insideElement ?? false,
      };
    });
    expect(appearance).not.toBeNull();
    expect(appearance!.distance).toBeLessThanOrEqual(2);
    expect(appearance!.inside).toBe(false);
    const label = appearance!.label;
    expect(label.length).toBeGreaterThan(0);
    for (const char of label) {
      await press(char, {});
    }
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="settings-page"]')
              ?.getAttribute("data-active-section") === "appearance",
        ),
      { timeout: 5_000, timeoutMsg: "设置页标签没有激活「外观」分区" },
    );

    // 设置页内 sneak：命中设置页可见文本（旧实现只在隐藏的 workspace 活动区域里搜，
    // 设置页文本永远搜不到，表现为 s 双字符完全没反应）。
    const snippet = (await browser.execute(() => {
      const page = document.querySelector('[data-testid="settings-page"]');
      if (!page) return null;
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = (node.nodeValue ?? "").trim();
        const rect = node.parentElement?.getBoundingClientRect();
        if (text.length >= 2 && rect && rect.width > 2 && rect.height > 2) {
          return text.slice(0, 2);
        }
        node = walker.nextNode();
      }
      return null;
    })) as string | null;
    expect(snippet).not.toBeNull();
    await press("s", { code: "KeyS" });
    await press(snippet![0]!, {});
    await press(snippet![1]!, {});
    await $(HINT_OVERLAY).waitForDisplayed({ timeout: 5_000 });
    expect(await $(HINT_OVERLAY).getText()).toContain(`sneak ${snippet}`);
    const sneakBadges = await browser.execute(
      () => Array.from(document.querySelectorAll("[data-vim-sneak-match]")).length,
    );
    expect(sneakBadges).toBeGreaterThan(0);
    await press("Escape", { code: "Escape" });
    await $(HINT_OVERLAY).waitForDisplayed({ reverse: true });

    await $('[data-testid="settings-back-button"]').click();
    await $(INDICATOR).waitForDisplayed({ timeout: 5_000 });
  });
});
