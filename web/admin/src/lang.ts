// langName maps Jellyfin's MediaStream.Language code (typically ISO 639-3,
// occasionally ISO 639-2/B aliases like "ger" for German) to a human-
// readable English name. Returns the original code uppercased when we
// don't have a mapping, so unfamiliar codes still render legibly.
//
// "und" ("undetermined") is the canonical Jellyfin value when the file's
// metadata doesn't specify an audio language; surfaced as "Unknown" so
// the badge isn't a cryptic three-letter blob to a non-linguist.
const NAMES: Record<string, string> = {
    eng: "English",
    spa: "Spanish",
    fra: "French",
    fre: "French",
    deu: "German",
    ger: "German",
    ita: "Italian",
    por: "Portuguese",
    nld: "Dutch",
    dut: "Dutch",
    swe: "Swedish",
    nor: "Norwegian",
    dan: "Danish",
    fin: "Finnish",
    isl: "Icelandic",
    pol: "Polish",
    ces: "Czech",
    cze: "Czech",
    slk: "Slovak",
    hun: "Hungarian",
    ron: "Romanian",
    rum: "Romanian",
    bul: "Bulgarian",
    rus: "Russian",
    ukr: "Ukrainian",
    ell: "Greek",
    gre: "Greek",
    tur: "Turkish",
    heb: "Hebrew",
    ara: "Arabic",
    fas: "Persian",
    per: "Persian",
    hin: "Hindi",
    ben: "Bengali",
    tha: "Thai",
    vie: "Vietnamese",
    ind: "Indonesian",
    msa: "Malay",
    may: "Malay",
    tgl: "Tagalog",
    fil: "Filipino",
    jpn: "Japanese",
    kor: "Korean",
    zho: "Chinese",
    chi: "Chinese",
    cmn: "Mandarin",
    yue: "Cantonese",
    cat: "Catalan",
    eus: "Basque",
    baq: "Basque",
    glg: "Galician",
    afr: "Afrikaans",
    swa: "Swahili",
    und: "Unknown",
};

export function langName(code: string | undefined | null): string {
    const c = (code ?? "").trim().toLowerCase();
    if (!c) return "";
    return NAMES[c] ?? c.toUpperCase();
}

export function isUnknownLang(code: string | undefined | null): boolean {
    return (code ?? "").trim().toLowerCase() === "und";
}
