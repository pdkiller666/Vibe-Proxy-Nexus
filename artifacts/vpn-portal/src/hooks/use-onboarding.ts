import { useState, useCallback } from "react";

const STORAGE_KEY = "vpnexus_dismissed_tips_v1";

function getDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function useOnboarding() {
  const [dismissed, setDismissed] = useState<Set<string>>(getDismissed);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);

  const isVisible = useCallback((id: string) => !dismissed.has(id), [dismissed]);

  return { isVisible, dismiss };
}
