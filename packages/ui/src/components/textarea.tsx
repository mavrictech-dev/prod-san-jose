import * as React from "react";
import { cn } from "cn";
export function Textarea({className,...props}:React.ComponentProps<"textarea">){
  return <textarea data-slot="textarea" className={cn("min-h-24 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 aria-invalid:border-destructive",className)} {...props}/>;
}
