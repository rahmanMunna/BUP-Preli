"use client";

import { CircleSlash, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDirectiveType, formatHourList, formatKwh, formatPercent } from "@/lib/format";
import type { DirectiveInterpretation, StructuredAdjustment } from "@/lib/types";

/** Turns a structured adjustment into the sentence an operator would say. */
function describeAdjustment(
  type: string,
  adjustment: StructuredAdjustment,
): string | null {
  const hours = Array.isArray(adjustment.hours) ? adjustment.hours : [];
  const hourText = hours.length ? formatHourList(hours) : "the whole day";

  switch (type) {
    case "solar_reduction":
      return typeof adjustment.factor === "number"
        ? `Solar output cut by ${formatPercent(adjustment.factor)} at ${hourText}.`
        : null;
    case "minimum_battery_reserve":
      return typeof adjustment.reserve_kwh === "number"
        ? `Battery held at or above ${formatKwh(adjustment.reserve_kwh)}${
            hours.length ? ` during ${hourText}` : ""
          }.`
        : null;
    case "no_charge_window":
      return `Charging blocked at ${hourText}.`;
    case "no_discharge_window":
      return `Discharging blocked at ${hourText}.`;
    case "max_grid_window":
      return typeof adjustment.max_kwh === "number"
        ? `Grid import capped at ${formatKwh(adjustment.max_kwh)} in each of ${hourText}.`
        : null;
    default:
      return null;
  }
}

interface DirectiveCardProps {
  directive: DirectiveInterpretation;
  note?: string;
}

function DirectiveCard({ directive, note }: DirectiveCardProps) {
  const applied = directive.applies && directive.directive_type !== "no_op";
  const summary = describeAdjustment(
    directive.directive_type,
    directive.structured_adjustment,
  );
  const hours = Array.isArray(directive.structured_adjustment.hours)
    ? directive.structured_adjustment.hours
    : [];

  return (
    <li className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground tabular text-xs">
          Note {directive.note_index + 1}
        </span>
        <Badge variant={applied ? "default" : "secondary"} className="gap-1">
          {applied ? (
            <Sparkles aria-hidden className="size-3" />
          ) : (
            <CircleSlash aria-hidden className="size-3" />
          )}
          {formatDirectiveType(directive.directive_type)}
        </Badge>
        {hours.length > 0 ? (
          <span className="text-muted-foreground tabular text-xs">
            {hours.length} hour{hours.length === 1 ? "" : "s"} affected
          </span>
        ) : null}
      </div>

      {note ? (
        <blockquote className="text-muted-foreground mt-2 border-l-2 pl-3 text-sm italic">
          {note}
        </blockquote>
      ) : null}

      {summary ? <p className="mt-2 text-sm font-medium">{summary}</p> : null}

      <p className="text-muted-foreground mt-1 text-sm">
        {directive.explanation}
      </p>

      {applied ? (
        <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-2 text-xs">
          {JSON.stringify(directive.structured_adjustment)}
        </pre>
      ) : null}
    </li>
  );
}

export function DirectiveViewerSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface DirectiveViewerProps {
  directives: DirectiveInterpretation[];
  notes: string[];
}

export function DirectiveViewer({ directives, notes }: DirectiveViewerProps) {
  if (directives.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground p-6 text-sm">
          No operator notes were submitted, so there is nothing to interpret.
          The schedule below is the unconstrained cost optimum.
        </CardContent>
      </Card>
    );
  }

  const applied = directives.filter(
    (directive) => directive.applies && directive.directive_type !== "no_op",
  ).length;

  return (
    <Card className="overflow-hidden py-0">
      <div className="text-muted-foreground bg-muted/40 border-b px-4 py-2.5 text-xs">
        {applied} of {directives.length} note
        {directives.length === 1 ? "" : "s"} became an active directive. Every
        note is listed, in the order it was submitted.
      </div>
      <ul>
        {directives.map((directive) => (
          <DirectiveCard
            key={directive.note_index}
            directive={directive}
            note={notes[directive.note_index]}
          />
        ))}
      </ul>
    </Card>
  );
}
