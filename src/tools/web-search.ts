
import { tool } from "ai";
import { z } from "zod";

const SearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      content: z.string(),
      score: z.number().nullish(),
      published_date: z.string().nullish(),
    })
  ),
});

async function searchTavily(query: string) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is missing");
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Tavily error: ${response.status}`);
  }

  const data = SearchResponseSchema.parse(
    await response.json()
  );

  return data.results.map((item) => ({
    title: item.title,
    url: item.url,
    content: item.content,
    score: item.score ?? undefined,
    publishedDate: item.published_date ?? undefined,
  }));
}

type SearchHit = {
  searchQuery: string;
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
};

type SearchFailure = {
  searchQuery: string;
  error: string;
};

type SearchResult = SearchHit | SearchFailure;

export const webSearch = tool({
  description: `
    Search the public web for current and historical information.

    Generate focused search queries.
    Prefer official documentation, pricing pages,
    changelogs and announcements.

    For change detection, include relevant dates
    and date ranges in your queries.

    Submit up to three independent queries together.
    Never invent search results, dates or URLs.
  `,

  inputSchema: z.object({
    queries: z
      .array(z.string().min(3).max(300))
      .min(1)
      .max(3)
      .describe("One to three focused web search queries"),
  }),

  execute: async ({ queries }): Promise<SearchResult[]> => {
    const uniqueQueries = [...new Set(queries)];

    const results = await Promise.allSettled(
      uniqueQueries.map(searchTavily)
    );

    const output: SearchResult[] = [];

    results.forEach((result, index) => {
      const searchQuery = uniqueQueries[index];

      if (result.status === "fulfilled") {
        const hits: SearchHit[] = result.value.map((item) => ({
          ...item,
          searchQuery,
        }));

        output.push(...hits);
      } else {
        console.error(
          `Search failed for "${searchQuery}":`,
          result.reason
        );

        const failure: SearchFailure = {
          searchQuery,
          error:
            "This search failed. Other results may still be available.",
        };

        output.push(failure);
      }
    });

    return output;
  },
});
