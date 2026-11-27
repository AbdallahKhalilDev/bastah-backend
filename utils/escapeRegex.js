// Escapes regex special characters in user input so we can safely build a regex
// from it. Without this, a search for "(" would be an INVALID regex and throw a
// 500 — and a crafted input could make the regex do surprising things. This
// turns every special char (. * + ? ( ) [ ] etc.) into a plain literal.
//
// Every search builds its regex through utils/searchPattern.js, which calls
// this for each character, so there is ONE place that decides what "safe" means.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = escapeRegex;
