import type { PromptTheme } from "../types";

export interface PromptSpec {
  text: string;
  theme: PromptTheme;
}

/**
 * Build the prompt battery for a project. Prompts are unbranded category
 * queries (what a real buyer would ask an assistant) plus a couple of
 * branded probes. Branded prompts are tagged so metrics can exclude them
 * from headline mention rates — asking about the brand by name trivially
 * inflates its appearance.
 */
export function generatePromptBattery(input: {
  brand: string;
  category: string;
  audience: string | null;
}): PromptSpec[] {
  const { brand, category } = input;
  const aud = input.audience ? ` for ${input.audience}` : "";

  return [
    { text: `What are the best ${category}${aud}?`, theme: "discovery" },
    { text: `Top ${category} to consider in 2026`, theme: "discovery" },
    {
      text: `I'm looking for ${category}${aud} — what do you recommend?`,
      theme: "recommendation",
    },
    {
      text: `Which ${category} should I choose${aud}? Give me a shortlist.`,
      theme: "recommendation",
    },
    {
      text: `List the leading ${category} and what makes each one stand out.`,
      theme: "discovery",
    },
    {
      text: `What ${category} do experts recommend${aud}?`,
      theme: "recommendation",
    },
    { text: `Compare the top options for ${category}.`, theme: "comparison" },
    {
      text: `What are the pros and cons of the most popular ${category}?`,
      theme: "comparison",
    },
    {
      text: `If you could only pick one of the ${category}, which would it be and why?`,
      theme: "recommendation",
    },
    {
      text: `What's the best choice among ${category} on a limited budget?`,
      theme: "use_case",
    },
    {
      text: `Which ${category} are the most trusted right now?`,
      theme: "use_case",
    },
    {
      text: `What are good alternatives to the most popular ${category}?`,
      theme: "comparison",
    },
    {
      text: `Is ${brand} a good option? What do people say about it?`,
      theme: "branded",
    },
    {
      text: `How does ${brand} compare to other ${category}?`,
      theme: "branded",
    },
  ];
}
