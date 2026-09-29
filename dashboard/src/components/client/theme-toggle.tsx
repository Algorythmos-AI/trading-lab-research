"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

export const THEME_KEY = "tl-theme";

function subscribe(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}
const current = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => null);
  const next = theme === "dark" ? "light" : "dark";
  const toggle = () => {
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggle}
      aria-label={theme ? `Switch to ${next} theme` : "Switch theme"}
      title={theme ? `Switch to ${next} theme` : "Switch theme"}
    >
      {theme === "light" ? <Moon aria-hidden /> : <Sun aria-hidden />}
    </Button>
  );
}

/** Runs before first paint: stored choice, else the OS preference, else dark. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.classList.toggle("dark",t==="dark")}catch(e){}})();`;
