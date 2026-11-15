import { bookViewing } from "@/tools/book-viewing";
import { getAvailableSlots } from "@/tools/get-available-slots";
import { getListing } from "@/tools/get-listing";
import { handoffToHuman } from "@/tools/handoff-to-human";
import { searchListings } from "@/tools/search-listings";
import type { AgentTool } from "@/tools/types";
import { updateLead } from "@/tools/update-lead";

export type { AgentTool, ToolContext, ToolError } from "@/tools/types";

/** Every tool the agent can call. The model adapters expose exactly this list. */
export const TOOLS: readonly AgentTool[] = [
  searchListings,
  getListing,
  updateLead,
  getAvailableSlots,
  bookViewing,
  handoffToHuman,
];

export const TOOLS_BY_NAME: ReadonlyMap<string, AgentTool> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);
