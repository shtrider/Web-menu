import "@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEEPL_KEY = Deno.env.get("DEEPL_API_KEY") || "";
const GOOGLE_KEY = Deno.env.get("GOOGLE_TRANSLATE_KEY") || "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";

async function translateDeepL(text: string, targetLang: string): Promise<string> {
  const res = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      "Authorization": `DeepL-Auth-Key ${DEEPL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: [text],
      source_lang: "IT",
      target_lang: targetLang,
    }),
  });
  if (!res.ok) throw new Error(`DeepL error: ${res.status}`);
  const data = await res.json();
  return data.translations?.[0]?.text || text;
}

async function translateGoogle(text: string, targetLang: string): Promise<string> {
  if (GOOGLE_KEY) {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source: "it", target: targetLang, format: "text" }),
    });
    if (!res.ok) throw new Error(`Google error: ${res.status}`);
    const data = await res.json();
    return data.data?.translations?.[0]?.translatedText || text;
  }
  // Fallback to MyMemory if no Google key
  const apiLang = targetLang === "zh" ? "zh-CN" : targetLang;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=it|${apiLang}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory error: ${res.status}`);
  const data = await res.json();
  return data.responseData?.translatedText || text;
}

const DEEPL_LANGS: Record<string, string> = {
  en: "EN-GB", es: "ES", fr: "FR", de: "DE"
};
const ASIAN_LANGS = ["zh", "ja"];

const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", zh: "Chinese (Simplified)", ja: "Japanese"
};

async function refineFoodTranslations(
  originalIt: string,
  translations: Record<string, string>
): Promise<Record<string, string>> {
  if (!ANTHROPIC_KEY) return translations;

  try {
    const translationEntries = Object.entries(translations)
      .map(([lang, text]) => `<${lang}>${text}</${lang}>`)
      .join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: `You are a professional food-menu translator that refines machine translations of Italian restaurant dish descriptions. Apply these rules:

1. Detect food-specific terminology (ingredients, cooking methods, dish names) and replace literal translations with culturally appropriate equivalents (e.g., "soffritto" → "aromatic base of onions, carrots, and celery").
2. Adjust idioms or cultural references so they evoke the same feeling in the target culture (e.g., "comfort food" → a phrase natural in the target language).
3. Preserve the original register (formal, casual, promotional, etc.).
4. Consider the whole sentence for context — do NOT rely on direct dictionary lookups.
5. Keep descriptions concise and appetizing, suitable for a restaurant menu.
6. Return ONLY the refined translations in the exact XML format requested, no extra text.`,
        messages: [{
          role: "user",
          content: `Original Italian: "${originalIt}"

Machine translations:
${translationEntries}

Refine each translation following the food-menu guidelines. Return each refined translation in the same XML tag format:
${Object.keys(translations).map(lang => `<${lang}>refined text here</${lang}>`).join("\n")}`
        }]
      }),
    });

    if (!res.ok) return translations;

    const data = await res.json();
    const content = data.content?.[0]?.text || "";

    const refined = { ...translations };
    for (const lang of Object.keys(translations)) {
      const match = content.match(new RegExp(`<${lang}>([\\s\\S]*?)</${lang}>`));
      if (match?.[1]?.trim()) {
        refined[lang] = match[1].trim();
      }
    }
    return refined;
  } catch {
    return translations;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { texts, context } = await req.json();
    // texts: [{ text: "...", id: "name" }, { text: "...", id: "description" }]
    // context: optional, "food_menu" enables AI-powered food translation refinement

    if (!Array.isArray(texts) || texts.length === 0) {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allLangs = [...Object.keys(DEEPL_LANGS), ...ASIAN_LANGS];
    const results: Record<string, Record<string, string>> = {};

    for (const item of texts) {
      results[item.id] = {};
      const translations = await Promise.all(
        allLangs.map(async (lang) => {
          try {
            const translated = lang in DEEPL_LANGS
              ? await translateDeepL(item.text, DEEPL_LANGS[lang])
              : await translateGoogle(item.text, lang);
            return [lang, translated];
          } catch {
            return [lang, item.text];
          }
        })
      );
      for (const [lang, text] of translations) {
        results[item.id][lang as string] = text as string;
      }

      // Apply food-menu AI refinement for descriptions
      if (context === "food_menu" && item.id === "description" && item.text.trim()) {
        results[item.id] = await refineFoodTranslations(item.text, results[item.id]);
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Translation failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
