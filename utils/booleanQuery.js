// Reads a yes/no filter from the URL, like ?inStock=false or ?isVerified=true.
//
// Query values always arrive as TEXT: ?inStock=false gives the string "false",
// and in JavaScript the string "false" counts as TRUE (any non-empty text does).
// So we never use the raw value as a boolean. We accept exactly the two words
// "true" and "false", turn them into a real boolean, and reject anything else:
// a typo shouldn't silently show everything.
//
// Returns:
//   { value: undefined }   the filter wasn't given (or was empty): don't filter
//   { value: true/false }  filter on it
//   { problem }            anything else → pass it to next() (400)
function parseBooleanQuery(raw, name) {
  if (raw === undefined || raw === "") {
    return { value: undefined };
  }
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  return { problem: { status: 400, message: `${name} must be true or false` } };
}

module.exports = parseBooleanQuery;
