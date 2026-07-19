// Escapes regex special characters in user input so we can safely build a regex
// from it. Without this, a search for "(" would be an INVALID regex and throw a
// 500 — and a crafted input could make the regex do surprising things. This
// turns every special char (. * + ? ( ) [ ] etc.) into a plain literal.
//
// It lives in its own tiny file because more than one place now needs it: the
// product search AND the global search (which searches three models at once).
// One copy means they can never disagree about what "safe" means.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = escapeRegex;
