"use client";

import { TriangleAlert } from "lucide-react";
import { Empty } from "@/components/empty";

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <Empty icon={TriangleAlert} title="This page could not be drawn">
      Part of the snapshot could not be displayed. The page retries on the next refresh.
      {error.digest ? <span className="font-mono"> Reference {error.digest}.</span> : null}
    </Empty>
  );
}
