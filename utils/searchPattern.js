// Builds the pattern EVERY search in Bastah uses: the shop, product and global
// search, and the admin lists' ?q. Given what someone typed, it returns a regex
// that finds names CONTAINING it, ignoring capitals and Arabic spelling
// variants. Returns null when there's nothing to search for.
//
// WHY: Arabic has letters people write in more than one way, and a plain regex
// compares letters exactly. Most people type "اطفال" with no hamza, so a
// product saved as "أطفال" was never found. The same goes for ه written for ة,
// ي for ى, and vowel marks (harakat) typed in the search or saved in a name.
//
// HOW: we don't change any stored data. Instead, each letter of the search
// becomes a small "any of these" group in the regex:
//   "اطفال"  →  [اأإآٱ] ط ف [اأإآٱ] ل   (spaces added here only to read it)
// so it matches "أطفال", "اطفال" and "إطفال" alike. And between every two
// letters we allow any number of vowel marks, so "عسل" also finds "عسلٌ".
//
// Because nothing is stored differently, there is nothing to update in the
// database: old and new products are searched the same way.

const escapeRegex = require("./escapeRegex");

// Letters that people use in place of each other. Each string is ONE group:
// typing any letter of a group matches every letter in it.
const LETTER_GROUPS = [
  "اأإآٱ", // alef, with or without a hamza or madda
  "ةه", // taa marbuta and haa (حقيبة / حقيبه)
  "يىئ", // yaa, alef maqsura, yaa with hamza (حلوى / حلوي)
  "وؤ", // waw, with or without a hamza
];

// Vowel marks (fatha, damma, kasra, tanween, shadda, sukun, ...), the small
// alef above a letter, and the tatweel stretch "ـ". They never change which
// word it is, so we drop them from the search and skip them in the names.
//
// NOTE the SINGLE backslashes: in a normal JS string "ً" IS the mark
// character itself, so the regex we send contains the real characters. We
// can't send the "ً" notation (double backslash) instead, because
// MongoDB's regex engine doesn't understand it and rejects the whole search.
const MARKS = "ً-ٰٟـ";
const MARKS_IN_TEXT = new RegExp(`[${MARKS}]`, "g");
const OPTIONAL_MARKS = `[${MARKS}]*`;

function searchPattern(text) {
  // 1. Clean what was typed: drop the vowel marks, trim the ends.
  const cleaned = typeof text === "string" ? text.replace(MARKS_IN_TEXT, "").trim() : "";
  if (!cleaned) return null;

  // 2. Turn each character into its piece of the pattern.
  const pieces = [];
  for (const char of cleaned) {
    if (/\s/.test(char)) {
      // A run of spaces matches one or more spaces, so a double space typed by
      // accident still finds the name. (Add it once per run, not per space.)
      if (pieces[pieces.length - 1] !== "\\s+") pieces.push("\\s+");
      continue;
    }
    const group = LETTER_GROUPS.find((letters) => letters.includes(char));
    // A variant letter becomes its whole group; anything else is matched
    // literally, with escapeRegex making "(" or "+" harmless as before.
    pieces.push(group ? `[${group}]` : escapeRegex(char));
  }

  // 3. Allow vowel marks between any two pieces, and ignore capitals ("i").
  return new RegExp(pieces.join(OPTIONAL_MARKS), "i");
}

module.exports = searchPattern;
