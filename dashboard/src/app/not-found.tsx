import Link from "next/link";
import { Empty } from "@/components/empty";

export default function NotFound() {
  return (
    <Empty title="This page does not exist">
      Use the section links above, or go back to the <Link className="text-primary underline" href="/">overview</Link>.
    </Empty>
  );
}
