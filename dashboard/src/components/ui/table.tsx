import * as React from "react";
import { cn } from "@/lib/utils";

/** Tables scroll inside their card on narrow screens; the page itself never scrolls sideways. */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-[0.8125rem]", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("hover:bg-muted/50 border-b transition-colors", className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "text-muted-foreground h-8 px-2 text-left align-middle text-xs font-medium whitespace-nowrap first:pl-0 last:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td data-slot="table-cell" className={cn("px-2 py-2 align-middle whitespace-nowrap first:pl-0 last:pr-0", className)} {...props} />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("text-muted-foreground mt-3 text-xs", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell, TableCaption };
