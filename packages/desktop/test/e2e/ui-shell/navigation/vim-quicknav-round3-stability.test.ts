/**
 * Round 3 稳定性隔离探针：Automations 激活（Q1-17/Q1-18/Q2-17 首跑偶发项）
 * 与生成中 stop 状态，独立进程运行，避免被前序用例的残留状态混淆。
 */
import {
  E2E_REPLY_TOKEN,
  V4_MAIN_PANE_ID,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session";
import { expect as wdioExpect } from "@wdio/globals";
import { clearAppData } from "#e2e/helpers/desktop-app";

const INDICATOR = '[data-testid="vim-mode-indicator"]';

let taskId = "";

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

async function pressLabel(label: string) {
  for (const char of label.split("")) await press(char, {});
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

async function ensureNormal() {
  if ((await indicatorText()).includes("INSERT")) {
    await press("[", { code: "BracketLeft", ctrlKey: true });
    await browser.pause(150);
  }
  if ((await indicatorText()).includes("INSERT")) {
    await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
    await browser.pause(150);
  }
  await browser.waitUntil(async () => (await indicatorText()).includes("NORMAL"), {
    timeout: 10_000,
    timeoutMsg: "Vim 徽标没有进入 NORMAL",
  });
}

async function openHints() {
  if (await $("[data-vim-hint-overlay]").isExisting()) {
    await press("Escape", { code: "Escape" });
    await browser.pause(100);
  }
  await press("f", { code: "KeyF" });
  try {
    await browser.waitUntil(
      () => browser.execute(() => Boolean(document.querySelector("[data-vim-hint-overlay]"))),
      { timeout: 2_000 },
    );
    return (await browser.execute(
      () => document.querySelectorAll("[data-vim-hint-overlay] span").length,
    )) as number;
  } catch {
    return -1;
  }
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

async function backToChat() {
  await press("Escape", { code: "Escape" });
  await press("Escape", { code: "Escape" });
  await press("Escape", { code: "Escape" });
  await press("Escape", { code: "Escape", ctrlKey: true, altKey: true });
  await ensureVimEnabled();
  await ensureNormal();
  await browser.execute(() => {
    document
      .querySelectorAll<HTMLElement>('[data-testid="desktop-top-nav-back"]')
      .forEach((element) => element.click());
    document
      .querySelectorAll<HTMLElement>('[data-testid="settings-back-button"]')
      .forEach((element) => element.click());
  });
  await browser.pause(400);
}

describe("Round 3 稳定性隔离探针", () => {
  before(async function () {
    this.timeout(300_000);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    const marker = `E2E_VIM_R3S_${Date.now()}`;
    await sendV4Prompt(buildReadonlyToolPrompt(marker));
    await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
      "稳定性探针前置任务没有完成",
      120_000,
      V4_MAIN_PANE_ID,
    );
    taskId = (await browser.execute(
      () =>
        document
          .querySelector<HTMLElement>('[data-testid^="task-item-"]')
          ?.getAttribute("data-testid") ?? "",
    )) as string;
    expect(taskId, "没有拿到前置任务 id").not.toBe("");
    await browser.pause(500);
  });

  after(async () => {
    await clearAppData();
  });

  it("S1 Automations 激活 5 次（独立进程、前序零状态）", async () => {
    const results: { attempt: number; opened: boolean; ms: number; badges: number }[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await backToChat();
      const started = Date.now();
      const badges = await openHints();
      const label = await hintLabelForTestid("automations-open");
      expect(
        label,
        `第 ${attempt} 次 automations-open 没有标签（badges=${badges}）`,
      ).not.toBeNull();
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
      results.push({ attempt, opened, ms: Date.now() - started, badges });
      await backToChat();
    }
    console.log(`S1 Automations 独立进程激活结果=${JSON.stringify(results)}`);
    expect(
      results.every((entry) => entry.opened),
      `Automations 独立进程激活存在失败: ${JSON.stringify(results)}`,
    ).toBe(true);
  });

  it("S2 生成中 stop 状态：5 次采样，stop 可见时必须可标签", async () => {
    await backToChat();
    const results: {
      attempt: number;
      sawStop: boolean;
      visibleStop: boolean;
      stopFacts: Record<string, unknown> | null;
      stopLabel: string | null;
      labelEvidence: boolean;
      badges: number;
    }[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const marker = `E2E_VIM_R3S_RUN_${Date.now()}_${attempt}`;
      await sendV4Prompt(`${marker}: reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
      const start = Date.now();
      let sawStop = false;
      let visibleStop = false;
      while (Date.now() - start < 8_000) {
        const fact = (await browser.execute(() => {
          const element = document.querySelector<HTMLElement>('[data-testid="v4-stop"]');
          if (!element) return { exists: false, visible: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            exists: true,
            visible:
              rect.width > 2 &&
              rect.height > 2 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number.parseFloat(style.opacity || "1") > 0.01 &&
              element.closest("[inert], [aria-hidden='true']") === null,
          };
        })) as { exists: boolean; visible: boolean };
        if (fact.exists) sawStop = true;
        if (fact.visible) {
          visibleStop = true;
          break;
        }
        await browser.pause(40);
      }
      let stopLabel: string | null = null;
      let badges = -1;
      let stopFacts: Record<string, unknown> | null = null;
      if (visibleStop) {
        stopFacts = (await browser.execute(() => {
          const elements = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="v4-stop"]'),
          );
          const element = elements.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 2 && rect.height > 2;
          });
          if (!element) return { count: elements.length, visibleElement: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
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
          return {
            count: elements.length,
            visibleElement: true,
            rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
            opacity: style.opacity,
            visibility: style.visibility,
            display: style.display,
            pointerEvents: style.pointerEvents,
            ariaHiddenAncestor: Boolean(element.closest("[aria-hidden='true']")),
            inertAncestor: Boolean(element.closest("[inert]")),
            disabled: (element as HTMLButtonElement).disabled === true,
            ariaDisabled: element.getAttribute("aria-disabled"),
            matchesInteractiveSelector: element.matches(INTERACTIVE),
            checkVisibility:
              typeof (element as HTMLElement & { checkVisibility?: () => boolean })
                .checkVisibility === "function"
                ? (element as HTMLElement & { checkVisibility: () => boolean }).checkVisibility()
                : null,
            clientRects: element.getClientRects().length,
          };
        })) as Record<string, unknown> | null;
        await ensureNormal();
        badges = await openHints();
        const hintFacts = (await browser.execute(() => {
          const element = document.querySelector<HTMLElement>('[data-testid="v4-stop"]');
          if (!element) return { stopAtHint: false };
          const rect = element.getBoundingClientRect();
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
          return {
            stopAtHint: true,
            rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
            buttonsInOverlay: badges.length,
            exactMatches: badges.filter(
              (badge) =>
                Number.isFinite(badge.left) &&
                Math.abs(badge.left - rect.left) <= 3 &&
                Math.abs(badge.top - rect.top) <= 3 &&
                Math.abs(badge.width - rect.width) <= 3 &&
                Math.abs(badge.height - rect.height) <= 3,
            ),
            activeTestid: document.activeElement?.getAttribute("data-testid") ?? "",
          };
        })) as Record<string, unknown>;
        stopFacts = { ...stopFacts, hintFacts };
        const exactMatches = Array.isArray(hintFacts.exactMatches)
          ? (hintFacts.exactMatches as unknown[])
          : [];
        // 原子快照：stop 与提示层同时存在且 rect 精确命中 = 该次有效；stop 已消失=快速流竞态，剔除。
        const labelEvidence = hintFacts.stopAtHint === true && exactMatches.length > 0;
        stopLabel = await hintLabelForTestid("v4-stop");
        results.push({
          attempt,
          sawStop,
          visibleStop,
          stopFacts,
          stopLabel,
          labelEvidence,
          badges,
        });
        await press("Escape", { code: "Escape" });
      } else {
        results.push({
          attempt,
          sawStop,
          visibleStop,
          stopFacts: null,
          stopLabel: null,
          labelEvidence: false,
          badges: -1,
        });
      }
      await browser.waitUntil(
        () => browser.execute(() => document.querySelector('[data-testid="v4-stop"]') === null),
        { timeout: 60_000, timeoutMsg: "生成没有结束" },
      );
    }
    console.log(`S2 生成中采样=${JSON.stringify(results)}`);
    const valid = results.filter((entry) => entry.labelEvidence);
    const raced = results.filter((entry) => {
      const hintFacts = (entry.stopFacts?.hintFacts ?? null) as Record<string, unknown> | null;
      return hintFacts !== null && hintFacts.stopAtHint === false;
    });
    const invalid = results.filter((entry) => {
      const hintFacts = (entry.stopFacts?.hintFacts ?? null) as Record<string, unknown> | null;
      return hintFacts !== null && hintFacts.stopAtHint === true && !entry.labelEvidence;
    });
    console.log(
      `S2 有效采样=${valid.length} 快速流竞态剔除=${raced.length} 无效=${invalid.length}`,
    );
    expect(valid.length, "没有任何一次 stop 与提示层同帧的原子证据").toBeGreaterThan(0);
    expect(invalid, `stop 与提示层同帧但未获得标签: ${JSON.stringify(invalid)}`).toEqual([]);
  });

  it("S3 打开并关闭文件预览后，Automations 激活仍然可用", async () => {
    await backToChat();
    // 打开侧栏文件树 → 激活文件行 → 关闭文件 tab。
    await press("b", { code: "KeyB", ctrlKey: true, altKey: true });
    await browser.pause(400);
    await ensureNormal();
    await openHints();
    const filesLabel = await hintLabelForTestidSelector('[data-side-pane-open-tab-item="files"]');
    expect(filesLabel, "文件树 launcher 没有标签").not.toBeNull();
    await pressLabel(filesLabel!);
    await browser.pause(700);
    await ensureNormal();
    await openHints();
    const fileRowLabel = await hintLabelForTestidSelectorPrefix(
      '[data-testid^="workspace-file-tree-row-"]',
    );
    if (fileRowLabel !== null) {
      await pressLabel(fileRowLabel);
      await browser.pause(700);
    } else {
      console.log("S3 文件树没有可标签行，仅验证打开/关闭文件面板后的 Automations");
    }
    await press("Escape", { code: "Escape" });
    await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>("[data-side-pane-tab-id]");
      tab?.querySelector<HTMLElement>("button[aria-label]")?.click();
    });
    await browser.pause(500);

    const results: { attempt: number; opened: boolean; ms: number }[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await ensureNormal();
      const started = Date.now();
      await openHints();
      const label = await hintLabelForTestid("automations-open");
      expect(label, `S3 第 ${attempt} 次 automations-open 没有标签`).not.toBeNull();
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
      await backToChat();
    }
    console.log(`S3 预览后 Automations 激活=${JSON.stringify(results)}`);
    expect(
      results.every((entry) => entry.opened),
      `预览后 Automations 激活存在失败: ${JSON.stringify(results)}`,
    ).toBe(true);
  });
});

async function hintLabelForTestidSelector(selector: string): Promise<string | null> {
  return hintLabelForAny(selector);
}

async function hintLabelForTestidSelectorPrefix(selector: string): Promise<string | null> {
  return hintLabelForAny(selector);
}

async function hintLabelForAny(selector: string): Promise<string | null> {
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
