"use client";

import { AlertTriangle, LineChart, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SummaryCardsSkeleton } from "@/components/summary-cards";
import { API_BASE_URL, type ApiError } from "@/lib/api";

/** Nothing has been optimized yet — say what pressing the button will do. */
export function EmptyState({ onOptimize }: { onOptimize: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <div className="bg-muted rounded-full p-3">
          <LineChart aria-hidden className="text-muted-foreground size-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-base font-semibold">No schedule yet</h2>
          <p className="text-muted-foreground text-sm">
            Review the scenario on the left, then optimize. The operator notes
            go to the language model, the directives it returns are validated,
            and the solver produces a 24-hour dispatch plan.
          </p>
        </div>
        <Button onClick={onOptimize} className="mt-1">
          Optimize energy
        </Button>
      </CardContent>
    </Card>
  );
}

/** A run is in flight — mirror the real layout so nothing jumps on arrival. */
export function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <SummaryCardsSkeleton />
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-52" />
              <Skeleton className="h-[220px] w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-muted-foreground text-center text-xs">
        Interpreting the notes and solving the schedule. This usually takes a
        few seconds, and up to a minute if the language model is under load.
      </p>
    </div>
  );
}

interface ErrorStateProps {
  error: ApiError;
  onRetry: () => void;
  isRetrying: boolean;
}

export function ErrorState({ error, onRetry, isRetrying }: ErrorStateProps) {
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden className="size-4" />
      <AlertTitle>{error.message}</AlertTitle>
      <AlertDescription className="space-y-3">
        {error.details.length > 0 ? (
          <ul className="list-inside list-disc space-y-0.5 text-sm">
            {error.details.slice(0, 6).map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        ) : null}

        <p className="text-xs">
          API endpoint: <code className="font-mono">{API_BASE_URL}</code>
        </p>

        {error.isRetryable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={isRetrying}
          >
            <RefreshCw
              aria-hidden
              className={isRetrying ? "size-3.5 animate-spin" : "size-3.5"}
            />
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
