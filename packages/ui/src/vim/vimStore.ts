/**
 * Vim 导航的 UI 状态：开关与帮助浮层。
 *
 * - 开关是纯 UI 偏好（不走 AppSettings/跨窗口同步）：同一窗口内立即生效，
 *   持久化到 localStorage，重启后保持；
 * - 帮助浮层是瞬时状态，不持久化。
 */
import { useSyncExternalStore } from "react";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

const ENABLED_STORAGE_KEY = "zcode.vim-navigation.enabled";

function readInitialEnabled(): boolean {
  return readSafeLocalStorage(ENABLED_STORAGE_KEY) === "1";
}

let enabled = readInitialEnabled();
let helpOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isVimNavigationEnabled(): boolean {
  return enabled;
}

export function setVimNavigationEnabled(next: boolean): void {
  if (enabled === next) {
    return;
  }
  enabled = next;
  writeSafeLocalStorage(ENABLED_STORAGE_KEY, next ? "1" : "0");
  if (!next) {
    helpOpen = false;
  }
  emit();
}

export function toggleVimNavigationMode(): void {
  setVimNavigationEnabled(!enabled);
}

export function isVimHelpOpen(): boolean {
  return helpOpen;
}

export function setVimHelpOpen(next: boolean): void {
  if (helpOpen === next) {
    return;
  }
  helpOpen = next;
  emit();
}

export function toggleVimHelp(): void {
  setVimHelpOpen(!helpOpen);
}

/** React 订阅：开关变化（含其它 hook 触发的 toggle）即时重渲。 */
export function useVimNavigationEnabled(): boolean {
  return useSyncExternalStore(subscribe, isVimNavigationEnabled, () => false);
}

export function useVimHelpOpen(): boolean {
  return useSyncExternalStore(subscribe, isVimHelpOpen, () => false);
}
