import { useEffect, useRef } from "react";

/**
 * Scrolls an expanding section into view after it is mounted.
 * Centering the section keeps both the warning and its action buttons visible
 * on short mobile viewports.
 */
export function useScrollToExpanded(expanded: boolean) {
  const sectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expanded) return;

    const frameId = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [expanded]);

  return sectionRef;
}