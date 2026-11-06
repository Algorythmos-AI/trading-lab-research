import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The Options page's size scale (globals.css: text-decision, text-price, text-live, text-level, text-explain) is a
// font size, not a colour: told so, tailwind-merge keeps a colour class written beside one.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["decision", "price", "live", "level", "explain"] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
