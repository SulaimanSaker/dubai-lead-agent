/**
 * Guardrails checked in code, after the model writes its reply. See src/agent/CLAUDE.md.
 */

export interface MoneyAmount {
  /** The text as written, e.g. "AED 1.2M". */
  raw: string;
  /** The amount in AED. */
  value: number;
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const GROUPED = String.raw`\d{1,3}(?:,\d{3})+`;
const END = String.raw`(?![\w²])`;
/** Next to a currency, "m" means million ("AED 1.5m"). */
const SUFFIX = String.raw`\s?(?:[kK]|thousand|mn|million|[mM])${END}`;
/** Without a currency, lowercase "m" is usually metres ("500m from the beach"), so only "M" counts. */
const BARE_SUFFIX = String.raw`\s?(?:[kK]|M|mn|million)${END}`;
const CURRENCY = String.raw`(?:AED|Aed|aed|DHS|Dhs?\.?|dhs?\.?|[Dd]irhams?|درهم)`;

/**
 * Money in text: "AED 115,000", "AED1.2M", "1.2 million AED", "115k dirhams", a bare "120k" / "1.2M",
 * or a bare comma-grouped amount of 10,000 or more ("95,000/year"). Plain numbers ("2 bed", "10:00",
 * "2026", "500m") are not money.
 */
const MONEY = new RegExp(
  `${CURRENCY}\\s?(${NUM})(${SUFFIX})?` +
    `|(${NUM})(${SUFFIX})?\\s?${CURRENCY}` +
    `|(${NUM})(${BARE_SUFFIX})` +
    `|(${GROUPED})(?!\\.?\\d)`,
  "g",
);

/** Arabic-Indic digits and separators → ASCII, so "١٢٠٬٠٠٠ درهم" is read like "120,000 درهم". */
function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
}

function toAed(number: string, suffix: string | undefined): number {
  const base = Number.parseFloat(number.replace(/,/g, ""));
  const unit = (suffix ?? "").trim().toLowerCase();
  const factor = unit === "k" || unit === "thousand" ? 1_000 : unit === "" ? 1 : 1_000_000;
  // Two decimals, not whole numbers: "AED 1.5" must not become 2.
  return Math.round(base * factor * 100) / 100;
}

export function findMoneyAmounts(text: string): MoneyAmount[] {
  return [...normalizeDigits(text).matchAll(MONEY)].flatMap((match) => {
    if (match[7] !== undefined) {
      const value = toAed(match[7], undefined);
      return value >= 10_000 ? [{ raw: match[0], value }] : [];
    }
    const number = match[1] ?? match[3] ?? match[5] ?? "0";
    const suffix = match[2] ?? match[4] ?? match[6];
    return [{ raw: match[0].trim(), value: toAed(number, suffix) }];
  });
}

/** Every number in a text, including money with k/M suffixes. Used for the allowed sources. */
function allNumbers(text: string): number[] {
  const normalized = normalizeDigits(text);
  const plain = [...normalized.matchAll(new RegExp(NUM, "g"))].map((m) => toAed(m[0], undefined));
  return [...plain, ...findMoneyAmounts(normalized).map((amount) => amount.value)];
}

/**
 * Amounts in the reply that no tool returned in this conversation.
 * The buyer's own budget is allowed once saved, because update_lead returns it. A number that only the
 * buyer said ("Is L02 really 80k?") is NOT a source: the model must not confirm it without a tool.
 */
export function findInventedPrices(reply: string, toolResults: readonly string[]): MoneyAmount[] {
  const allowed = new Set(toolResults.flatMap(allNumbers));
  return findMoneyAmounts(reply).filter((amount) => !allowed.has(amount.value));
}

/** The note added to the next call when a draft reply had invented prices. */
export function priceCorrectionNote(invented: readonly MoneyAmount[]): string {
  return (
    `Correction: your draft reply mentioned ${invented.map((a) => a.raw).join(", ")}, which no tool returned. ` +
    "Rewrite the reply using only prices exactly as the tools returned them (yearly for rent), " +
    "or call a tool to get the price."
  );
}

const ARABIC = /[؀-ۿ]/;

export type SafeReplyKind = "price_check" | "error" | "refusal" | "handoff";

const SAFE_REPLIES: Record<SafeReplyKind, { en: string; ar: string }> = {
  price_check: {
    en: "Let me double-check the exact price for you. Which property would you like the details of?",
    ar: "دعني أتأكد من السعر الدقيق لك. ما العقار الذي تريد تفاصيله؟",
  },
  error: {
    en: "Sorry, something went wrong on my side. Could you send your last message again?",
    ar: "عذرًا، حدث خطأ من جهتي. هل يمكنك إرسال رسالتك الأخيرة مرة أخرى؟",
  },
  refusal: {
    en: "Sorry, I can't help with that here. I can help you find a home, or connect you with a human agent.",
    ar: "عذرًا، لا يمكنني المساعدة في ذلك هنا. يمكنني مساعدتك في إيجاد منزل أو توصيلك بوكيل عقاري.",
  },
  handoff: {
    en: "Sorry, I'm having trouble with this. I've passed your request to a human agent, who will contact you.",
    ar: "عذرًا، أواجه مشكلة في ذلك. لقد حوّلت طلبك إلى وكيل عقاري وسيتواصل معك.",
  },
};

/** A fixed, safe reply in the buyer's language (Arabic if their message has Arabic letters). */
export function safeReply(kind: SafeReplyKind, buyerMessage: string): string {
  const texts = SAFE_REPLIES[kind];
  return ARABIC.test(buyerMessage) ? texts.ar : texts.en;
}
