"use client";

// The last boundary: an error in the root layout itself, where the site's own shell, styles and fonts may be the
// thing that failed. It draws its own html and body, with inline styles only.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0b0f14", color: "#e6e8eb" }}>
        <main role="alert" style={{ maxWidth: 560, margin: "15vh auto", padding: "0 16px", lineHeight: 1.5 }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>The dashboard could not be drawn</h1>
          <p style={{ margin: "0 0 16px", color: "#a3a9b1" }}>
            Its frame failed to load, so no page can show. Nothing here places orders, and nothing was changed.
            {error.digest ? ` Reference ${error.digest}.` : ""}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ font: "inherit", padding: "6px 14px", borderRadius: 6, border: "1px solid #3a414a", background: "transparent", color: "inherit", cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
