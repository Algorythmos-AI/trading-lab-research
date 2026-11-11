/** `phoneIntro`: a shorter intro a phone shows (and reads out) in place of `intro`, which shows from sm up. */
export function PageHeading({ title, intro, phoneIntro }: { title: string; intro: string; phoneIntro?: string }) {
  return (
    <div className="grid gap-1">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        {phoneIntro ? (
          <>
            <span className="sm:hidden">{phoneIntro}</span>
            <span className="max-sm:hidden">{intro}</span>
          </>
        ) : (
          intro
        )}
      </p>
    </div>
  );
}
