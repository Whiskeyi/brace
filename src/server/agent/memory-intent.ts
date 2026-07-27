const chineseImperativePrefix =
  /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我|务必|一定要|以后)/i;
const chineseMemoryAction =
  /^(?:记住|记下|记下来|保存到(?:你的)?(?:长期)?记忆(?:中)?|存入(?:你的)?(?:长期)?记忆(?:中)?)(?:\s|[:：,，]|$)/i;

function hasChineseMemoryImperative(message: string): boolean {
  return message.split(/[\n。！？!?；;,，]/).some((clause) => {
    let remaining = clause.trimStart();
    let prefix = chineseImperativePrefix.exec(remaining);

    while (prefix) {
      remaining = remaining.slice(prefix[0].length).trimStart();
      prefix = chineseImperativePrefix.exec(remaining);
    }

    return chineseMemoryAction.test(remaining);
  });
}

/**
 * This parser intentionally recognizes only direct, imperative memory requests.
 * Ambiguous questions and negated requests remain read-only.
 */
export function hasExplicitMemoryWriteIntent(message: string): boolean {
  const normalized = message.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return false;

  const negated =
    /(?:不要|别|无需|不需要|请勿|禁止|不得|不用|不想让你)\s*.{0,12}(?:记住|记下|保存|存入)/i.test(
      normalized,
    ) ||
    /\b(?:do\s+not|don't|never|please\s+do\s+not)\s+(?:remember|save|store)\b/i.test(
      normalized,
    );
  if (negated) return false;

  const chineseExplicitRequest =
    /(?:^|[\n。！？!?；;,，])\s*我(?:明确)?(?:要求|希望|想让)你\s*(?:记住|记下|记下来|保存|存入)(?:\s|[:：,，]|$)/i;
  const englishImperative =
    /(?:^|[\n.!?;,])\s*(?:(?:please|always)\s+)?(?:remember\b|don't\s+forget\b|save\s+(?:this|that|the\s+following)?\s*(?:to|in)\s+(?:your\s+)?(?:long[- ]term\s+)?memory\b|store\s+.{1,120}\s+in\s+(?:your\s+)?(?:long[- ]term\s+)?memory\b)/i;
  const englishExplicitRequest =
    /(?:^|[\n.!?;,])\s*I\s+(?:explicitly\s+)?(?:want|need|ask)\s+you\s+to\s+(?:remember|save|store)\b/i;

  return (
    hasChineseMemoryImperative(normalized) ||
    chineseExplicitRequest.test(normalized) ||
    englishImperative.test(normalized) ||
    englishExplicitRequest.test(normalized)
  );
}
