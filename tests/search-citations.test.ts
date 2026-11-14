import { describe, expect, it } from "vitest";

import { appendFallbackSourceLinks, type SearchHit } from "../src/tools/web-search";

const hit = (query: string, url: string, title = "Official pricing"): SearchHit => ({
  searchQuery: query,
  title,
  url,
  content: "Source result content supports a tested finding.",
  publishedDate: "2026-11-10",
  retrievedAt: "2026-11-14T10:00:00.000Z",
});

describe("fallback research citations", () => {
  it("adds clickable source links and dates when the answer omitted citations", () => {
    const answer = appendFallbackSourceLinks("The published plan costs $20 per user.", [
      hit("HubSpot official pricing", "https://hubspot.com/pricing"),
    ]);

    expect(answer).toContain("[Official pricing](https://hubspot.com/pricing)");
    expect(answer).toContain("published 2026-11-10");
    expect(answer).toContain("checked 2026-11-14");
  });

  it("removes unsupported links and limits fallback references to one per search", () => {
    const hits = [
      { ...hit("HubSpot pricing", "https://hubspot.com/pricing", "HubSpot pricing"), score: 0.9 },
      { ...hit("HubSpot pricing", "https://hubspot.com/old", "Older result"), score: 0.2 },
      hit("Pipedrive pricing", "https://pipedrive.com/pricing", "Pipedrive pricing"),
    ];
    const answer = appendFallbackSourceLinks("See [unverified source](https://fake.example/price) for pricing.", hits);

    expect(answer).not.toContain("fake.example");
    expect(answer).toContain("[HubSpot pricing](https://hubspot.com/pricing)");
    expect(answer).toContain("[Pipedrive pricing](https://pipedrive.com/pricing)");
    expect(answer).not.toContain("https://hubspot.com/old");
  });

  it("keeps a citation that directly matches a returned search result", () => {
    const answer = "Verified on [the official page](https://hubspot.com/pricing).";
    expect(appendFallbackSourceLinks(answer, [hit("HubSpot pricing", "https://hubspot.com/pricing")])).toBe(answer);
  });
});
