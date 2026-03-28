import "@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEEPL_KEY = Deno.env.get("DEEPL_API_KEY") || "";
const GOOGLE_KEY = Deno.env.get("GOOGLE_TRANSLATE_KEY") || "";

async function translateDeepL(text: string, targetLang: string): Promise<string> {
  const res = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      auth_key: DEEPL_KEY,
      text: text,
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
    const { texts } = await req.json();
    // texts: [{ text: "...", id: "name" }, { text: "...", id: "description" }]

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
