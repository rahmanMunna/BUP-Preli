"use client";

import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface LegendEntry {
  label: string;
  color: string;
}

interface ChartFrameProps {
  title: string;
  description?: string;
  /**
   * Two or more series always carry a legend — identity must never rest on
   * colour matching alone. A single series needs none: the title names it.
   */
  legend?: LegendEntry[];
  footnote?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function ChartFrame({
  title,
  description,
  legend,
  footnote,
  action,
  className,
  children,
}: ChartFrameProps) {
  const showLegend = (legend?.length ?? 0) >= 2;

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="gap-1 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {description ? (
              <CardDescription className="mt-0.5 text-xs">
                {description}
              </CardDescription>
            ) : null}
          </div>
          {action}
        </div>

        {showLegend ? (
          <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            {legend?.map((entry) => (
              <li
                key={entry.label}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
              </li>
            ))}
          </ul>
        ) : null}
      </CardHeader>

      <CardContent className="pt-0">{children}</CardContent>

      {footnote ? (
        <div className="text-muted-foreground border-t px-6 py-2.5 text-xs">
          {footnote}
        </div>
      ) : null}
    </Card>
  );
}
