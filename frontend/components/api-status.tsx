"use client";

import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useApiHealth } from "@/hooks/use-api-health";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Tells the operator the backend is reachable before they wait on a long
 * optimize call. Status is carried by an icon and a word, never colour alone.
 */
export function ApiStatus() {
  const { status, details } = useApiHealth();

  const Icon =
    status === "checking" ? Loader2 : status === "online" ? CircleCheck : CircleX;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
            status === "online" && "text-status-good",
            status === "offline" && "text-status-critical",
            status === "checking" && "text-muted-foreground",
          )}
        >
          <Icon
            aria-hidden
            className={cn("size-3.5", status === "checking" && "animate-spin")}
          />
          API {status}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="font-mono text-xs">{API_BASE_URL}</p>
        {status === "online" && details ? (
          <ul className="mt-1 space-y-0.5 text-xs">
            <li>
              Interpreter key:{" "}
              {details.llm_configured ? "configured" : "missing — notes will no-op"}
            </li>
            <li>
              Optimizer service:{" "}
              {details.optimizer_reachable
                ? "reachable"
                : "unreachable — the API will use its local fallback"}
            </li>
          </ul>
        ) : status === "offline" ? (
          <p className="mt-1 text-xs">
            Start the NestJS service, or set NEXT_PUBLIC_API_BASE_URL to where
            it listens.
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
