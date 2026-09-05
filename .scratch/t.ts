import { mockNewsSource } from "../src/data/news.ts";
import { briefsFor } from "../src/data/briefs.ts";
for (const syms of [["SOL","XRP","BNB"], ["TSLA","AMD","META"]]) {
  let t = Date.now();
  const b = briefsFor(syms as string[], 424242);
  console.log(syms.join(","), "briefs", Date.now()-t, "ms", Array.isArray(b) ? b.length : typeof b);
}
