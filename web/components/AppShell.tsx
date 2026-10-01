"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ensureStarted, useStore } from "@/lib/store";
import { QuickPanel, useShortcuts } from "./QuickPanel";
import { Toasts } from "./Toasts";
import { TopBar } from "./TopBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  useEffect(() => ensureStarted(), []);
  useShortcuts();
  const router = useRouter();
  const pathname = usePathname();
  const focus = useStore((s) => s.focusSymbol);
  useEffect(() => {
    if (focus && ["/portfolio", "/scorecard", "/report", "/live"].some((p) => pathname.startsWith(p))) router.push(`/${focus.symbol}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  return (
    <>
      <TopBar />
      {children}
      <QuickPanel />
      <Toasts />
    </>
  );
}
