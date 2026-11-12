import { Notice } from "@/components/ui/notice";
import { builtFromNotice, type Options } from "@/lib/options";

/**
 * The Options page's warning for levels not built from the close just before their session: a pull that missed a
 * session, a wrong or missing stamp. Draws nothing when the edition was built from the right close.
 */
export function OldCloseNotice({ e }: { e: Pick<Options, "session" | "built_from"> }) {
  const text = builtFromNotice(e.session, e.built_from);
  if (!text) return null;
  return (
    <Notice tone="bad" size="sm" role="alert">
      {text}
    </Notice>
  );
}
